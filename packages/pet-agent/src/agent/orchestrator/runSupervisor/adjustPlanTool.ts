import { tool, type ToolRuntime } from '@langchain/core/tools';
import { supervisorControlSchemas, type SupervisorControl } from './protocol';
import { SupervisorDecisionError, identity, type SupervisorHandoffContext, type SupervisorDecision } from './controlContext';
import { currentSupervisorTask } from './state';
import type { SupervisorToolSession } from './toolSession';
import { executionsForTask } from '../executionMessages';

export function createAdjustPlanTool(session: SupervisorToolSession) {
  return tool((args, runtime: ToolRuntime) =>
    session(runtime, 'adjust_plan', (current, callId) => adjustPlan(current, args, callId)), {
    name: 'adjust_plan',
    schema: supervisorControlSchemas.adjust_plan,
    verboseParsingErrors: true,
    description: '调整计划并返回更新后的事实，由你继续决定下一步。',
  });
}

type AdjustPlanArgs = Extract<SupervisorControl, { name: 'adjust_plan' }>['args'];

export function adjustPlan(
  context: SupervisorHandoffContext,
  args: AdjustPlanArgs,
  callId: string,
): SupervisorDecision {
  if (!context.hasNewUserInput && args.goal !== (context.state.goal ?? context.userRequest)) {
    throw new SupervisorDecisionError('Changing the goal requires fresh user input.');
  }
  if (args.tasks.some(task => !context.allowedCapabilityNames.includes(task.capability))) {
    throw new SupervisorDecisionError('Plan selects a capability outside the current catalog.');
  }
  const current = currentSupervisorTask(context.state);
  const reuse = args.currentDelegation === 'continue';
  if (reuse && current && current.capability !== args.tasks[0].capability) {
    throw new SupervisorDecisionError('Continuing a task must keep its capability.');
  }
  const retained = context.state.plan.filter(task => task.status === 'completed' || task.status === 'superseded'
    || (executionsForTask(context, task.id).length > 0 && !(reuse && task.id === current?.id)))
    .map(task => task.status === 'completed' ? task : { ...task, status: 'superseded' as const });
  return { state: { goal: args.goal, plan: [...retained, ...args.tasks.map((task, index) => ({
    ...task,
    id: reuse && index === 0 && current ? current.id : identity('task', context.runId, callId, String(index)),
    status: 'pending' as const,
  }))] }, execution: null };
}
