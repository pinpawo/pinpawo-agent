import { createSupervisorControlValidationMiddleware } from './controlMiddleware';
import { createSubmitPlanTool } from './submitPlanTool';
import { createReviewCurrentTool } from './reviewCurrentTool';
import { createAdjustPlanTool } from './adjustPlanTool';
import { createDelegateCapabilityTool } from './delegateCapabilityTool';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { GraphRecursionError } from '@langchain/langgraph';
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
import { supervisorWorkMessages } from './workMessages';
import { supervisorControlContext } from './input';

/**
 * Graph steps, roughly 20 model turns. A healthy invocation uses 2-6 turns; this
 * only stops a runaway tool loop.
 */
export const RUN_SUPERVISOR_RECURSION_LIMIT = 40;

export const RUN_SUPERVISOR_STEP_LIMIT_NOTICE = '本轮规划的决策步数已达到上限，任务尚未完成，当前计划已保留。你可以继续当前任务。';

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
      const context = supervisorControlContext(input);
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
      // A stricter caller limit stays the caller's hard breaker; only this
      // invocation's own limit is a runtime stop with a notice.
      const callerRecursionLimit = runnableConfig?.recursionLimit;
      const ownsRecursionLimit = callerRecursionLimit === undefined || RUN_SUPERVISOR_RECURSION_LIMIT < callerRecursionLimit;
      let result;
      try {
        result = await agent.invoke({
          messages: agentMessages,
          runSupervisorState: input.state,
          disclosedCapabilityNames: [...input.capabilityDisclosure.disclosedCapabilityNames],
        }, {
          ...runnableConfig,
          recursionLimit: ownsRecursionLimit ? RUN_SUPERVISOR_RECURSION_LIMIT : callerRecursionLimit,
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
          // Preserve cancellation even when LangChain wraps a tool failure in a
          // middleware error.
          signal?.throwIfAborted();
        });
      } catch (error) {
        if (!(error instanceof GraphRecursionError) || !ownsRecursionLimit) throw error;
        // A runtime stop, like the Root iteration limit: keep the facts this
        // invocation started from and hand the user a deterministic notice.
        result = {
          runSupervisorState: input.state,
          disclosedCapabilityNames: [],
          messages: [...agentMessages, new AIMessage({
            id: `supervisor-step-limit:${input.runId}:${input.inputId}`,
            content: RUN_SUPERVISOR_STEP_LIMIT_NOTICE,
          })],
        };
      }

      // createAgent returns its input too. Persist only this invocation's new work;
      // never retag canonical main messages or the temporary catalog frame.
      const work = result.messages.slice(agentMessages.length);
      const capabilityDisclosure = mergeCapabilityDisclosure(input.capabilityDisclosure, result.disclosedCapabilityNames ?? []);
      const records = supervisorWorkMessages(context, work);
      const last = records.at(-1);
      if (AIMessage.isInstance(last) && !last.tool_calls?.length && last.text.trim()) {
        // Publish the final message itself; private tool-loop work stays in its lane.
        delete getAgentMessageMetadata(last).lane;
        stampAgentMessageCreatedAt(last);
        return { runSupervisorState: result.runSupervisorState, capabilityDisclosure, messages: records };
      }
      throw new Error('Supervisor must reply or explicitly request execution.');
    },
  };
}
