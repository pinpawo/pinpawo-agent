import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredTool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import { createSupervisorDocumentReader } from './capabilityDocuments';
import { buildRunSupervisorAgentInput, buildRunSupervisorAgentSystemPrompt } from '../prompts/runSupervisorAgent';
import type { RunSupervisorInput, RunSupervisorResult, RunSupervisorRunner } from './runner';
import { queryAgentMessages, setAgentMessageMetadata } from '../../messages';
import { orchestratorModelInvocationMiddleware } from '../modelInvocation';
import { systemPromptMiddleware } from '../../../prompts/systemPrompt';
import { mergeCapabilityDisclosure } from './capabilityDisclosure';
import { createSupervisorCapabilityDetailsTool, createSupervisorDisclosureStateMiddleware } from './detailsTool';
import { createCapabilityRoutingManifest } from './routingManifest';
import { createMessageSupervisorControlTools, createMessageSupervisorMiddleware, createSupervisorMessageHandoff } from './messageHandoff';
import { supervisorHandoffContext } from './input';

export function createRunSupervisorAgent(params: {
  model: BaseChatModel;
  defaultCapabilityName?: string;
  maxDocumentReadBytes?: number;
}): RunSupervisorRunner {
  return {
    async invoke(input: RunSupervisorInput, runnableConfig?: RunnableConfig): Promise<RunSupervisorResult> {
      const signal = runnableConfig?.signal;
      signal?.throwIfAborted();

      // Project Root history and read-only facts for this invocation.
      const context = supervisorHandoffContext(input);
      const documents = createSupervisorDocumentReader(input.catalog, params.maxDocumentReadBytes);
      const routing = createCapabilityRoutingManifest({
        catalog: input.catalog,
        defaultCapabilityName: params.defaultCapabilityName,
      });
      const disclosedDocuments = documents.readCapabilities(input.capabilityDisclosure.disclosedCapabilityNames, signal);
      const frame = new HumanMessage({
        id: `supervisor-input:${input.runId}:${input.inputId}`,
        content: buildRunSupervisorAgentInput(input, disclosedDocuments, routing),
      });
      const selected = queryAgentMessages(input.messages).main().supervisor(input.runId).select().messages;
      const agentMessages = [...selected, frame];
      const tools: StructuredTool[] = [
        ...(input.mode === 'entry' || context.hasNewUserInput ? [createSupervisorCapabilityDetailsTool({
          documents, capabilityNames: input.catalog.capabilityNames,
        })] : []),
        ...createMessageSupervisorControlTools(context),
      ];
      const agent = createAgent({
        name: 'runSupervisor',
        model: params.model,
        tools,
        systemPrompt: buildRunSupervisorAgentSystemPrompt(input.mode),
        middleware: [
          createMessageSupervisorMiddleware(context),
          createSupervisorDisclosureStateMiddleware(),
          systemPromptMiddleware,
          orchestratorModelInvocationMiddleware,
        ],
      });
      const result = await agent.invoke({
        messages: agentMessages,
        disclosedCapabilityNames: [...input.capabilityDisclosure.disclosedCapabilityNames],
      }, {
        ...runnableConfig,
        runName: 'framework.run_supervisor',
        tags: [...(runnableConfig?.tags ?? []), 'framework.run_supervisor'],
        metadata: {
          ...runnableConfig?.metadata,
          frameworkComponent: 'run_supervisor',
          traceId: input.traceId,
          runId: input.runId,
          supervisorInputId: input.inputId,
          registryDigest: input.catalog.registryDigest,
          supervisorMode: input.mode,
        },
      });
      signal?.throwIfAborted();
      documents.assertWithinBudget();

      // createAgent returns its input too. Persist only this invocation's new work;
      // never retag canonical main messages or the temporary catalog frame.
      const fresh = result.messages.slice(agentMessages.length);
      const work = fresh.map((message: BaseMessage) => setAgentMessageMetadata(message, {
        lane: 'supervisor', runId: input.runId, traceId: input.traceId,
      }));
      const capabilityDisclosure = mergeCapabilityDisclosure(input.capabilityDisclosure, result.disclosedCapabilityNames ?? []);
      const last = work.at(-1);
      if (AIMessage.isInstance(last) && !last.tool_calls?.length && last.text.trim()) {
        return { reply: last.text, capabilityDisclosure, messages: work };
      }
      const handoff = createSupervisorMessageHandoff(context, work);
      return { capabilityDisclosure, messages: [...work.slice(0, -2), ...handoff] };
    },
  };
}
