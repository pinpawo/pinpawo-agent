import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import { SupervisorDecisionError, type SupervisorControlContext } from './controlContext';
import { currentSupervisorTask, requirePlanGoal, updateSupervisorTask, type RunSupervisorState, type SupervisorAgentState } from './state';
import { executionsForPlanItem } from '../executionMessages';

export const reviewCurrentSchema = z.object({
  completed: z.boolean().describe('Whether to accept the current task\'s latest delivery. false keeps the task for further work; the tool does not trigger execution.'),
  reason: z.string().trim().min(1).max(2_000).describe('The basis for acceptance, or the work still missing.'),
}).strict();

export function createReviewCurrentTool(context: SupervisorControlContext) {
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
    description: 'Review the current delivery and record the conclusion. Returns the plan facts and does not trigger execution; you then decide whether to execute, adjust or reply directly.',
  });
}

export type ReviewCurrentArgs = z.infer<typeof reviewCurrentSchema>;

export function reviewCurrent(
  context: SupervisorControlContext,
  args: ReviewCurrentArgs,
): RunSupervisorState {
  const current = currentSupervisorTask(context.state);
  if (!current) throw new SupervisorDecisionError('There is no task to review.');
  // Review only advances progress; the plan's goal is carried, never re-derived.
  let state: SupervisorControlContext['state'] = { ...context.state, runId: context.runId,
    goal: requirePlanGoal(context.state), plan: [...context.state.plan] };
  if (args.completed) {
    const latestResult = executionsForPlanItem(context, current.id).at(-1)?.result;
    if (!latestResult || latestResult.status !== 'returned' || !latestResult.delivery) {
      throw new SupervisorDecisionError('Accepting a task requires its returned delivery. The current task has no returned delivery to accept; execute it or adjust the remaining plan.');
    }
    state = updateSupervisorTask(state, current.id, 'completed');
  }
  return state;
}
