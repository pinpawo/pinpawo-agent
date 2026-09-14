import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { supervisorControlSchemas } from './protocol';
import { SupervisorDecisionError, identity, type SupervisorHandoffContext } from './controlContext';
import { currentSupervisorTask } from './state';
import type { SupervisorAgentState } from './state';
import { executionsForTask } from '../executionMessages';
import { getAgentMessageMetadata } from '../../messages';

export function createDelegateCapabilityTool(context: SupervisorHandoffContext) {
  return tool((_args, runtime: ToolRuntime<SupervisorAgentState>) => {
    const state = runtime.state.runSupervisorState;
    const execution = delegateCapability({ ...context, state }, runtime.state.reviewFeedback ?? undefined);
    return new ToolMessage({ name: 'delegate_capability', tool_call_id: runtime.toolCallId,
      content: JSON.stringify({ plan: state, handoff: true }), artifact: execution,
    });
  }, {
    name: 'delegate_capability',
    schema: supervisorControlSchemas.delegate_capability,
    verboseParsingErrors: true,
    description: '执行当前计划项，将控制权交给 Capability。无需参数；运行时注入已确认的当前任务、按顺序排列的计划与本次补做意见。返回交付后由你继续判断。',
  });
}

export function delegateCapability(context: SupervisorHandoffContext, feedback?: string) {
  const state = context.state;
  const next = currentSupervisorTask(state);
  if (!next) throw new SupervisorDecisionError('There is no planned task to execute.');
  if (!context.allowedCapabilityNames.includes(next.capability)) throw new SupervisorDecisionError('Capability is no longer available.');
  const previous = executionsForTask(context, next.id).filter(({ metadata }) => metadata.runId === context.runId).at(-1);
  if (previous && !context.messages.some((message) => ToolMessage.isInstance(message)
    && message.tool_call_id === previous.call.id && !getAgentMessageMetadata(message).lane)) {
    throw new Error('Cannot dispatch again while the current execution has no result.');
  }
  return {
    taskId: next.id,
    delegationId: previous?.execution.delegationId ?? identity('delegation', context.runId, next.id),
    capability: next.capability,
    task: next.task,
    mode: previous ? 'continue' as const : 'initial' as const,
    briefing: JSON.stringify({
      task: next.task,
      plan: state.plan.map(({ capability, task, status }) => ({ capability, task, status })),
      ...(feedback ? { feedback } : {}),
    }, null, 2),
  };
}
