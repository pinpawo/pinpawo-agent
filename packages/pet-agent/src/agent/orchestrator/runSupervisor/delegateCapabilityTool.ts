import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import type { CapabilityExecutionInput } from './protocol';
import { SupervisorDecisionError, identity, type SupervisorHandoffContext } from './controlContext';
import { currentSupervisorTask } from './state';
import { executionsForPlanItem } from '../executionMessages';
import { setAgentMessageMetadata } from '../../messages';
import type { OrchestratorStateType } from '../state';
import { createCapabilityExecutor, type CapabilityExecutionOptions } from '../capabilityExecution';
import { getInvokeOptions, getInvokeRegistry } from '../runtime/config';

export const delegateCapabilitySchema = z.object({
  briefing: z.string().refine(text => text.trim().length > 0).describe('只为当前计划项准备执行说明。结合用户要求与已返回交付，说明要完成的工作、可复用结论和必要约束；不复制历史交付全文，不展开后续任务。'),
}).strict();

export type DelegateCapabilityArgs = z.infer<typeof delegateCapabilitySchema>;

/** One executable tool definition, exposed by Supervisor and run by Root ToolNode. */
export function createDelegateCapabilityTool(options: CapabilityExecutionOptions) {
  const executeCapability = createCapabilityExecutor(options);
  return tool(async (args, runtime: ToolRuntime<OrchestratorStateType, Record<string, unknown>>) => {
    const state = runtime.state;
    const registry = getInvokeRegistry(runtime.config);
    const invokeOptions = getInvokeOptions(runtime.config);
    const userRequest = state.runSupervisorState.goal ?? state.runUserRequest;
    if (!userRequest) throw new Error('Capability execution requires a goal.');
    const input = buildCapabilityExecutionInput({
      state: state.runSupervisorState, runId: state.runId, taskId: state.taskId, userRequest,
      messages: state.messages, mode: 'boundary', hasNewUserInput: false,
      allowedCapabilityNames: registry.capabilities.map(({ capability }) => capability.name)
        .filter(name => !invokeOptions.allowedCapabilityNames || invokeOptions.allowedCapabilityNames.includes(name)),
    }, args, state.runSupervisorReviewFeedback ?? undefined);
    const compiledCapability = registry.capabilities.find(({ capability }) => capability.name === input.capability)!;
    const execution = await executeCapability({
      capability: compiledCapability,
      delegation: { id: input.delegationId, runId: state.runId, taskId: state.taskId,
        userRequest, task: input.task, mode: input.mode, briefing: input.briefing },
      history: state.messages,
    }, {
      review: {
        authorizations: state.sessionToolAuthorizations.generation === registry.authorizationGeneration
          ? state.sessionToolAuthorizations.records : [],
        hostCapabilities: invokeOptions.reviewCapabilities, policy: invokeOptions.globalReviewPolicy,
      },
      runnableConfig: runtime.config,
    });
    // Native Command tool pattern: use the injected call ID for the actual result.
    const result = setAgentMessageMetadata(new ToolMessage({
      name: 'delegate_capability', tool_call_id: runtime.toolCallId,
      status: execution.status === 'missing_deliverable' ? 'error' : 'success',
      content: JSON.stringify({ status: execution.status, delivery: execution.delivery, artifacts: execution.artifacts }),
      artifact: input,
    }), { runId: state.runId, taskId: state.taskId, delegationId: input.delegationId,
      sourceCapability: input.capability, runtimeGenerated: true });
    return new Command({ update: {
      messages: [...execution.privateMessages, result],
      sessionCapabilityArtifacts: execution.artifacts,
      runIterationCount: state.runIterationCount + 1,
      sessionToolAuthorizations: { generation: registry.authorizationGeneration, records: execution.toolAuthorizations },
    } });
  }, {
    name: 'delegate_capability', schema: delegateCapabilitySchema, verboseParsingErrors: true,
    description: '为当前计划项准备 briefing 并引用相关的已有交付，交给 Capability 执行。运行时确定任务身份与能力；返回后由你继续判断。',
  });
}

export function buildCapabilityExecutionInput(context: SupervisorHandoffContext, args: DelegateCapabilityArgs, feedback?: string): CapabilityExecutionInput {
  const state = context.state;
  const next = currentSupervisorTask(state);
  if (!next) throw new SupervisorDecisionError('There is no planned task to execute.');
  if (!context.allowedCapabilityNames.includes(next.capability)) throw new SupervisorDecisionError('Capability is no longer available.');
  const previous = executionsForPlanItem(context, next.id).filter(({ metadata }) => metadata.runId === context.runId).at(-1);
  return {
    planItemId: next.id,
    delegationId: previous?.execution.delegationId ?? identity('delegation', context.runId, next.id),
    capability: next.capability,
    task: next.objective,
    mode: previous ? 'continue' as const : 'initial' as const,
    briefing: feedback ? `${args.briefing}\n\nReview feedback:\n${feedback}` : args.briefing,
  };
}
