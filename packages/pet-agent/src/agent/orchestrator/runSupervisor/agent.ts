import { createSupervisorControlValidationMiddleware } from './controlMiddleware';
import { createSubmitPlanTool } from './submitPlanTool';
import { createReviewCurrentTool } from './reviewCurrentTool';
import { createAdjustPlanTool } from './adjustPlanTool';
import { createDelegateCapabilityTool } from './delegateCapabilityTool';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredTool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import { createSupervisorDocumentReader } from './capabilityDocuments';
import { buildRunSupervisorAgentInput, buildRunSupervisorAgentSystemPrompt } from '../prompts/runSupervisorAgent';
import type { RunSupervisorInput, RunSupervisorResult, RunSupervisorRunner } from './runner';
import { queryAgentMessages, getAgentMessageMetadata, stampAgentMessageCreatedAt } from '../../messages';
import { toolProtocolMiddleware } from '../modelInvocation';
import { systemPromptMiddleware } from '../../../prompts/systemPrompt';
import { mergeCapabilityDisclosure } from './capabilityDisclosure';
import { createSupervisorCapabilityDetailsTool } from './detailsTool';
import { createCapabilityRoutingManifest } from './routingManifest';
import { supervisorWorkMessages } from './messageHandoff';
import { supervisorHandoffContext } from './input';

export function createRunSupervisorAgent(params: {
  model: BaseChatModel;
  defaultCapabilityName?: string;
  maxDocumentReadBytes?: number;
  delegateCapabilityTool?: StructuredTool;
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
        createSubmitPlanTool(context),
        createReviewCurrentTool(context),
        createAdjustPlanTool(context),
        params.delegateCapabilityTool ?? createDelegateCapabilityTool({ models: { act: params.model, subagent: params.model } }),
      ];
      const agent = createAgent({
        name: 'runSupervisor',
        model: params.model,
        tools,
        systemPrompt: buildRunSupervisorAgentSystemPrompt(input.mode),
        middleware: [
          createSupervisorControlValidationMiddleware(input, agentMessages.length),
          systemPromptMiddleware,
          toolProtocolMiddleware,
        ],
      });
      const result = await agent.invoke({
        messages: agentMessages,
        runSupervisorState: input.state,
        disclosedCapabilityNames: [...input.capabilityDisclosure.disclosedCapabilityNames],
      }, {
        ...runnableConfig,
        runName: 'framework.run_supervisor',
        tags: [...(runnableConfig?.tags ?? []), 'framework.run_supervisor'],
        metadata: {
          ...runnableConfig?.metadata,
          frameworkComponent: 'run_supervisor',
          taskId: input.taskId,
          runId: input.runId,
          supervisorInputId: input.inputId,
          registryDigest: input.catalog.registryDigest,
          supervisorMode: input.mode,
        },
      }).finally(() => {
        // Preserve cancellation and the document-budget error code even when
        // LangChain wraps a tool failure in a middleware error.
        signal?.throwIfAborted();
        documents.assertWithinBudget();
      });

      // createAgent returns its input too. Persist only this invocation's new work;
      // never retag canonical main messages or the temporary catalog frame.
      const work = result.messages.slice(agentMessages.length);
      const capabilityDisclosure = mergeCapabilityDisclosure(input.capabilityDisclosure, result.disclosedCapabilityNames ?? []);
      const handoff = supervisorWorkMessages(context, work);
      const last = handoff.at(-1);
      if (AIMessage.isInstance(last) && !last.tool_calls?.length && last.text.trim()) {
        // Publish the final message itself; private tool-loop work stays in its lane.
        delete getAgentMessageMetadata(last).lane;
        stampAgentMessageCreatedAt(last);
        return { runSupervisorState: result.runSupervisorState, capabilityDisclosure, messages: handoff };
      }
      throw new Error('Supervisor must reply or explicitly request execution.');
    },
  };
}
