import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import { supervisorTaskSchema } from './protocol';
import { SupervisorDecisionError, identity, type SupervisorHandoffContext } from './controlContext';
import { currentSupervisorTask, type RunSupervisorState, type SupervisorAgentState } from './state';

export const submitPlanSchema = z.object({
  tasks: z.array(supervisorTaskSchema).min(1).max(24),
}).strict();

export function createSubmitPlanTool(context: SupervisorHandoffContext) {
  return tool((args, runtime: ToolRuntime<SupervisorAgentState>) => {
    const state = submitPlan({ ...context, state: runtime.state.runSupervisorState }, args, runtime.toolCallId);
    return new Command({ update: {
      runSupervisorState: state,
      reviewFeedback: null,
      messages: [new ToolMessage({ name: 'submit_plan', tool_call_id: runtime.toolCallId,
        content: JSON.stringify({ plan: state }),
      })],
    } });
  }, {
    name: 'submit_plan',
    schema: submitPlanSchema,
    verboseParsingErrors: true,
    description: '建立计划并返回计划事实，由你继续决定下一步。',
  });
}

export type SubmitPlanArgs = z.infer<typeof submitPlanSchema>;

export function submitPlan(
  context: SupervisorHandoffContext,
  args: SubmitPlanArgs,
  callId: string,
): RunSupervisorState {
  if (args.tasks.some(task => !context.allowedCapabilityNames.includes(task.capability))) {
    throw new SupervisorDecisionError('Plan selects a capability outside the current catalog.');
  }
  if (currentSupervisorTask(context.state) && !context.hasNewUserInput) {
    throw new SupervisorDecisionError('Replacing unfinished work requires fresh user input.');
  }
  return { runId: context.runId, goal: context.userRequest, plan: args.tasks.map((task, index) => ({
    ...task, id: identity('task', context.runId, callId, String(index)), status: 'pending',
  })) };
}
