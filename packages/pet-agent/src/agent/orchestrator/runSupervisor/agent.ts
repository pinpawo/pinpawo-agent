import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import { createAgent } from 'langchain';
import { createSupervisorDocumentReader } from './capabilityDocuments';
import { buildRunSupervisorAgentInput } from '../prompts/runSupervisorAgent';
import type {
  RunSupervisorInput,
  RunSupervisorResult,
  RunSupervisorRunner,
} from './runner';
import { parseSupervisorCommand } from './protocol';
import { queryAgentMessages } from '../../messages';
import { orchestratorModelInvocationMiddleware } from '../modelInvocation';
import { systemPromptMiddleware } from '../../../prompts/systemPrompt';
import { createSupervisorMiddleware } from './supervisorMiddleware';
import { supervisorCommandContext } from './supervisorState';
import {
  mergeCapabilityDisclosure,
} from './capabilityDisclosure';
import {
  createSupervisorCapabilityDetailsTool,
  createSupervisorDisclosureStateMiddleware,
} from './detailsTool';
import { createSupervisorCommandTools } from './commandTools';
import { createCapabilityRoutingManifest } from './routingManifest';

function buildSupervisorRunnableConfig(params: {
  input: RunSupervisorInput;
  runnableConfig?: RunnableConfig;
}): RunnableConfig {
  return {
    ...params.runnableConfig,
    runName: 'framework.run_supervisor',
    tags: [
      ...(params.runnableConfig?.tags ?? []),
      'framework.run_supervisor',
    ],
    metadata: {
      ...(params.runnableConfig?.metadata ?? {}),
      frameworkComponent: 'run_supervisor',
      traceId: params.input.traceId,
      runId: params.input.runId,
      supervisorInputId: params.input.inputId,
      registryDigest: params.input.catalog.registryDigest,
      supervisorMode: params.input.mode,
    },
  };
}

export function createRunSupervisorAgent(params: {
  model: BaseChatModel;
  /** Capability identified as the Supervisor's default candidate. */
  defaultCapabilityName?: string;
  maxDocumentReadBytes?: number;
}): RunSupervisorRunner {
  const middleware = createSupervisorMiddleware();

  return Object.freeze({
    async invoke(
      input: RunSupervisorInput,
      runnableConfig?: RunnableConfig,
    ): Promise<RunSupervisorResult> {
      const signal = runnableConfig?.signal;
      const config = buildSupervisorRunnableConfig({
        input,
        runnableConfig,
      });
      signal?.throwIfAborted();
      const routingManifest = createCapabilityRoutingManifest({
        catalog: input.catalog,
        ...(params.defaultCapabilityName !== undefined
          ? { defaultCapabilityName: params.defaultCapabilityName }
          : {}),
      });
      const documents = createSupervisorDocumentReader(input.catalog, params.maxDocumentReadBytes);
      const disclosedCapabilities = documents.readCapabilities(
        input.capabilityDisclosure.disclosedCapabilityNames, signal,
      );
      const supervisorInputMessage = new HumanMessage({
        id: `supervisor:${input.inputId}`,
        content: buildRunSupervisorAgentInput(
          input,
          disclosedCapabilities,
          routingManifest,
        ),
      });
      const agentMessages = queryAgentMessages(input.messages)
        .main()
        .append(supervisorInputMessage)
        .select()
        .messages;
      const agent = createAgent({
        name: 'runSupervisor',
        model: params.model,
        tools: [createSupervisorCapabilityDetailsTool({ documents }), ...createSupervisorCommandTools()],
        middleware: [
          middleware,
          createSupervisorDisclosureStateMiddleware(),
          systemPromptMiddleware,
          orchestratorModelInvocationMiddleware,
        ],
        checkpointer: false,
      });

      const result = await agent.invoke({
        messages: agentMessages,
        currentInput: input,
      }, config);
      signal?.throwIfAborted();
      documents.assertWithinBudget();
      const capabilityDisclosure = mergeCapabilityDisclosure(
        input.capabilityDisclosure,
        result.disclosedCapabilityNames ?? [],
      );
      if (result.supervisorCommand) {
        const command = parseSupervisorCommand(
          result.supervisorCommand,
          supervisorCommandContext(input),
        );
        return {
          ...command,
          capabilityDisclosure,
        };
      }
      const reply = result.messages.at(-1);
      if (!reply || !AIMessage.isInstance(reply) || reply.tool_calls?.length || !reply.text.trim()) {
        throw new Error('Supervisor produced neither a control proposal nor a usable final reply.');
      }
      return { reply: reply.text, capabilityDisclosure };
    },
  });
}
