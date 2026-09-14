import { tool, type ToolRuntime } from '@langchain/core/tools';
import { supervisorControlSchemas, type SupervisorControl } from './protocol';
import { SupervisorDecisionError, identity, type SupervisorHandoffContext, type SupervisorDecision } from './controlContext';
import { currentSupervisorTask } from './state';
import type { SupervisorToolSession } from './toolSession';

export function createSubmitPlanTool(session: SupervisorToolSession) {
  return tool((args, runtime: ToolRuntime) =>
    session(runtime, 'submit_plan', (current, callId) => submitPlan(current, args, callId)), {
    name: 'submit_plan',
    schema: supervisorControlSchemas.submit_plan,
    verboseParsingErrors: true,
    description: '建立计划并返回计划事实，由你继续决定下一步。',
  });
}

type SubmitPlanArgs = Extract<SupervisorControl, { name: 'submit_plan' }>['args'];

export function submitPlan(
  context: SupervisorHandoffContext,
  args: SubmitPlanArgs,
  callId: string,
): SupervisorDecision {
  if (args.tasks.some(task => !context.allowedCapabilityNames.includes(task.capability))) {
    throw new SupervisorDecisionError('Plan selects a capability outside the current catalog.');
  }
  if (currentSupervisorTask(context.state) && !context.hasNewUserInput) {
    throw new SupervisorDecisionError('Replacing unfinished work requires fresh user input.');
  }
  return { state: { goal: context.userRequest, plan: args.tasks.map((task, index) => ({
    ...task, id: identity('task', context.runId, callId, String(index)), status: 'pending',
  })) }, execution: null };
}
