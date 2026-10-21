import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import { supervisorTaskSchema } from './protocol';
import { SupervisorDecisionError, identity, type SupervisorControlContext } from './controlContext';
import { currentSupervisorTask, planGoal, type RunSupervisorState, type SupervisorAgentState } from './state';
import { executionsForPlanItem } from '../executionMessages';

export const adjustPlanSchema = z.object({
  adjustedGoal: z.string().trim().min(1).max(4_000).optional().describe('The calibrated goal, filled in when execution evidence shows the acceptance target needs calibration; later delegation and acceptance follow it. It must stay within the authorized scope of goal. Omit it when no calibration is needed; the existing adjusted goal stays.'),
  reason: z.string().trim().min(1).max(2_000).describe('The concrete execution evidence or new user requirement that makes the original plan no longer fit, and the minimal change needed now.'),
  currentTask: z.enum(['keep', 'replace']).describe('keep: keep the current plan item and its acceptance basis; the objective may change but the Capability stays. replace: create a new plan item. Every delegation runs independently.'),
  tasks: z.array(supervisorTaskSchema).min(1).max(24).describe('The remaining work after the adjustment. The runtime keeps completed items, so do not resubmit them; with keep, the first item is the current task, which keeps its identity and deliveries.'),
}).strict();

export function createAdjustPlanTool(context: SupervisorControlContext) {
  return tool((args, runtime: ToolRuntime<SupervisorAgentState>) => {
    const state = adjustPlan({ ...context, state: runtime.state.runSupervisorState }, args, runtime.toolCallId);
    return new Command({ update: {
      runSupervisorState: state,
      messages: [new ToolMessage({ name: 'adjust_plan', tool_call_id: runtime.toolCallId,
        content: JSON.stringify({ plan: state }),
      })],
    } });
  }, {
    name: 'adjust_plan',
    schema: adjustPlanSchema,
    verboseParsingErrors: true,
    description: 'Adjust the plan and return the updated facts; you then decide the next step.',
  });
}

export type AdjustPlanArgs = z.infer<typeof adjustPlanSchema>;

export function adjustPlan(
  context: SupervisorControlContext,
  args: AdjustPlanArgs,
  callId: string,
): RunSupervisorState {
  if (args.tasks.some(task => !context.allowedCapabilityNames.includes(task.capability))) {
    throw new SupervisorDecisionError('Plan selects a capability outside the current catalog.');
  }
  const current = currentSupervisorTask(context.state);
  const reuse = args.currentTask === 'keep';
  if (reuse && current && current.capability !== args.tasks[0].capability) {
    throw new SupervisorDecisionError('Continuing a task must keep its capability.');
  }
  const retained = context.state.plan.filter(task => task.status === 'completed' || task.status === 'superseded'
    || (executionsForPlanItem(context, task.id).length > 0 && !(reuse && task.id === current?.id)))
    .map(task => task.status === 'completed' ? task : { ...task, status: 'superseded' as const });
  const adjustedGoal = args.adjustedGoal ?? context.state.adjustedGoal;
  return { runId: context.runId, goal: planGoal(context), ...(adjustedGoal ? { adjustedGoal } : {}), plan: [...retained, ...args.tasks.map((task, index) => ({
    ...task,
    id: reuse && index === 0 && current ? current.id : identity('task', context.runId, callId, String(index)),
    status: 'pending' as const,
  }))] };
}
