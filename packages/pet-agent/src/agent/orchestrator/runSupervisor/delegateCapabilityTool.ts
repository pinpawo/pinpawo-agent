import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import type { CapabilityExecutionInput } from './protocol';
import { prepareCapabilityHandoff } from './messageHandoff';
import { SupervisorDecisionError, identity, type SupervisorHandoffContext } from './controlContext';
import { currentSupervisorTask, type SupervisorAgentState } from './state';
import { executionsForTask } from '../executionMessages';
import { getAgentMessageMetadata } from '../../messages';

export const delegateCapabilitySchema = z.object({}).strict();

export function createDelegateCapabilityTool(context: SupervisorHandoffContext) {
  return tool((_args, runtime: ToolRuntime<SupervisorAgentState & { messages: BaseMessage[] }>) => {
    const state = runtime.state.runSupervisorState;
    const input = buildCapabilityExecutionInput({ ...context, state }, runtime.state.reviewFeedback ?? undefined);
    const request = runtime.state.messages.at(-1);
    if (!AIMessage.isInstance(request) || request.tool_calls?.length !== 1
      || request.tool_calls[0].id !== runtime.toolCallId) throw new Error('Handoff requires its current AI tool call.');
    return new Command({ update: { messages: [prepareCapabilityHandoff(context, request, input)] } });
  }, {
    name: 'delegate_capability',
    schema: delegateCapabilitySchema,
    verboseParsingErrors: true,
    description: '执行当前计划项，将控制权交给 Capability。无需参数；运行时注入已确认的当前任务、按顺序排列的计划与本次补做意见。返回交付后由你继续判断。',
  });
}

export function buildCapabilityExecutionInput(context: SupervisorHandoffContext, feedback?: string): CapabilityExecutionInput {
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
      plan: state.plan.map(({ capability, task, status }) => ({ capability, task, status })),
      ...(feedback ? { feedback } : {}),
    }, null, 2),
  };
}
