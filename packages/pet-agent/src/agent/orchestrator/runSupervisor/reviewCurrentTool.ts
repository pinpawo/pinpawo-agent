import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import { SupervisorDecisionError, type SupervisorHandoffContext } from './controlContext';
import { currentSupervisorTask, updateSupervisorTask, type RunSupervisorState, type SupervisorAgentState } from './state';
import { executionsForPlanItem } from '../executionMessages';

export const reviewCurrentSchema = z.object({
  completed: z.boolean().describe('是否验收当前任务的最新交付。false 保留任务供后续补做；工具不触发执行。'),
  reason: z.string().trim().min(1).max(2_000).describe('验收依据或尚需补齐的工作。'),
}).strict();

export function createReviewCurrentTool(context: SupervisorHandoffContext) {
  return tool((args, runtime: ToolRuntime<SupervisorAgentState>) => {
    const state = reviewCurrent({ ...context, state: runtime.state.runSupervisorState }, args);
    return new Command({ update: {
      runSupervisorState: state,
      messages: [new ToolMessage({ name: 'review_current', tool_call_id: runtime.toolCallId,
        content: JSON.stringify({ plan: state }),
      })],
    } });
  }, {
    name: 'review_current',
    schema: reviewCurrentSchema,
    verboseParsingErrors: true,
    description: '验收当前交付并记录结论。返回计划事实，不触发执行；之后由你决定执行、调整或直接回复。',
  });
}

export type ReviewCurrentArgs = z.infer<typeof reviewCurrentSchema>;

export function reviewCurrent(
  context: SupervisorHandoffContext,
  args: ReviewCurrentArgs,
): RunSupervisorState {
  let state: SupervisorHandoffContext['state'] = { runId: context.runId,
    goal: context.state.goal ?? context.userRequest, plan: [...context.state.plan] };
  const current = currentSupervisorTask(state);
  if (!current) throw new SupervisorDecisionError('There is no task to review.');
  if (args.completed) {
    const latestResult = executionsForPlanItem(context, current.id).at(-1)?.result;
    if (!latestResult || latestResult.status !== 'returned' || !latestResult.delivery) {
      throw new SupervisorDecisionError('Accepting a task requires its returned delivery. The current task has no returned delivery to accept; execute it or adjust the remaining plan.');
    }
    state = updateSupervisorTask(state, current.id, 'completed');
  }
  return state;
}
