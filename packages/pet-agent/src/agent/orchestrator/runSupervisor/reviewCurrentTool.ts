import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { supervisorControlSchemas, type SupervisorControl } from './protocol';
import { SupervisorDecisionError, type SupervisorHandoffContext } from './controlContext';
import { currentSupervisorTask, updateSupervisorTask } from './state';
import { Command } from '@langchain/langgraph';
import type { RunSupervisorState, SupervisorAgentState } from './state';
import { executionsForTask } from '../executionMessages';

export function createReviewCurrentTool(context: SupervisorHandoffContext) {
  return tool((args, runtime: ToolRuntime<SupervisorAgentState>) => {
    const state = reviewCurrent({ ...context, state: runtime.state.runSupervisorState }, args);
    return new Command({ update: {
      runSupervisorState: state,
      reviewFeedback: args.completed ? null : args.reason,
      messages: [new ToolMessage({ name: 'review_current', tool_call_id: runtime.toolCallId,
        content: JSON.stringify({ plan: state }),
      })],
    } });
  }, {
    name: 'review_current',
    schema: supervisorControlSchemas.review_current,
    verboseParsingErrors: true,
    description: '验收当前交付并记录结论。返回计划事实，不触发执行；之后由你决定执行、调整或直接回复。',
  });
}

type ReviewCurrentArgs = Extract<SupervisorControl, { name: 'review_current' }>['args'];

export function reviewCurrent(
  context: SupervisorHandoffContext,
  args: ReviewCurrentArgs,
): RunSupervisorState {
  let state: SupervisorHandoffContext['state'] = { goal: context.state.goal ?? context.userRequest, plan: [...context.state.plan] };
  const current = currentSupervisorTask(state);
  if (!current) throw new SupervisorDecisionError('There is no task to review.');
  if (args.completed) {
    const latestResult = executionsForTask(context, current.id).at(-1)?.result;
    if (!latestResult || latestResult.status !== 'returned' || !latestResult.delivery) {
      throw new SupervisorDecisionError('Accepting a task requires its returned delivery. The current task has no returned delivery to accept; execute it or adjust the remaining plan.');
    }
    state = updateSupervisorTask(state, current.id, 'completed');
  }
  return state;
}
