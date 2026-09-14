import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import type { CapabilityExecutionInput } from './protocol';
import { SupervisorDecisionError, identity, type SupervisorHandoffContext } from './controlContext';
import { currentSupervisorTask } from './state';
import { executionsForTask } from '../executionMessages';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../../messages';
import type { OrchestratorStateType } from '../state';
import { createCapabilityExecutor, type CapabilityExecutionOptions } from '../capabilityExecution';
import { getInvokeOptions, getInvokeRegistry } from '../runtime/config';

export const delegateCapabilitySchema = z.object({}).strict();

/** One executable tool definition, exposed by Supervisor and run by Root ToolNode. */
export function createDelegateCapabilityTool(options: CapabilityExecutionOptions) {
  const executeCapability = createCapabilityExecutor(options);
  return tool(async (_args, runtime: ToolRuntime<OrchestratorStateType, Record<string, unknown>>) => {
    const state = runtime.state;
    if (state.messages.some(message => ToolMessage.isInstance(message) && message.tool_call_id === runtime.toolCallId
      && getAgentMessageMetadata(message).runId === state.runId && !getAgentMessageMetadata(message).lane)) {
      throw new Error('Capability call already has a result.');
    }
    const registry = getInvokeRegistry(runtime.config);
    const invokeOptions = getInvokeOptions(runtime.config);
    const userRequest = state.runSupervisorState.goal ?? state.runUserRequest;
    if (!userRequest) throw new Error('Capability execution requires a goal.');
    const input = buildCapabilityExecutionInput({
      state: state.runSupervisorState, runId: state.runId, traceId: state.traceId, userRequest,
      messages: state.messages, mode: 'boundary', hasNewUserInput: false,
      allowedCapabilityNames: registry.capabilities.map(({ capability }) => capability.name)
        .filter(name => !invokeOptions.allowedCapabilityNames || invokeOptions.allowedCapabilityNames.includes(name)),
    }, state.runSupervisorReviewFeedback ?? undefined);
    const compiledCapability = registry.capabilities.find(({ capability }) => capability.name === input.capability)!;
    const execution = await executeCapability({
      capability: compiledCapability,
      delegation: { id: input.delegationId, runId: state.runId, traceId: state.traceId,
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
    }), { runId: state.runId, traceId: state.traceId, delegationId: input.delegationId,
      sourceCapability: input.capability, runtimeGenerated: true });
    return new Command({ update: {
      messages: [...execution.privateMessages, result],
      sessionCapabilityArtifacts: execution.artifacts,
      runIterationCount: state.runIterationCount + 1,
      sessionToolAuthorizations: { generation: registry.authorizationGeneration, records: execution.toolAuthorizations },
    } });
  }, {
    name: 'delegate_capability', schema: delegateCapabilitySchema, verboseParsingErrors: true,
    description: '执行当前计划项，将控制权交给 Capability。无需参数；运行时注入当前任务、计划与补做意见。返回交付后由你继续判断。',
  });
}

export function buildCapabilityExecutionInput(context: SupervisorHandoffContext, feedback?: string): CapabilityExecutionInput {
  const state = context.state;
  const next = currentSupervisorTask(state);
  if (!next) throw new SupervisorDecisionError('There is no planned task to execute.');
  if (!context.allowedCapabilityNames.includes(next.capability)) throw new SupervisorDecisionError('Capability is no longer available.');
  const previous = executionsForTask(context, next.id).filter(({ metadata }) => metadata.runId === context.runId).at(-1);
  return {
    taskId: next.id,
    delegationId: previous?.execution.delegationId ?? identity('delegation', context.runId, next.id),
    capability: next.capability,
    task: next.task,
    mode: previous ? 'continue' as const : 'initial' as const,
    briefing: JSON.stringify({
      plan: state.plan.map(({ capability, task, status }) => ({ capability, task, status })),
      ...(feedback ? { feedback } : {}),
    }, null, 2),
  };
}
