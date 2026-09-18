import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import { supervisorTaskSchema } from './protocol';
import { SupervisorDecisionError, identity, type SupervisorHandoffContext } from './controlContext';
import { currentSupervisorTask, type RunSupervisorState, type SupervisorAgentState } from './state';
import { executionsForPlanItem } from '../executionMessages';

export const adjustPlanSchema = z.object({
  goal: z.string().trim().min(1).max(4_000).describe('没有新用户输入时必须原样保留当前 goal；只有用户明确要求或确认改变目标时才更新。'),
  reason: z.string().trim().min(1).max(2_000).describe('使原计划无法继续适用的具体执行证据或新用户要求，以及本次必要的最小调整。'),
  currentDelegation: z.enum(['continue', 'replace']).describe('continue：保留当前执行上下文，可修改 objective 但必须保持 Capability；replace：更换 Capability 或丢弃旧执行上下文。替换不代表旧任务完成。'),
  tasks: z.array(supervisorTaskSchema).min(1).max(24).describe('调整后的剩余工作。已完成事项由运行时保留，不重新提交；continue 时第一项对应保留身份与交付的当前任务。'),
}).strict();

export function createAdjustPlanTool(context: SupervisorHandoffContext) {
  return tool((args, runtime: ToolRuntime<SupervisorAgentState>) => {
    const state = adjustPlan({ ...context, state: runtime.state.runSupervisorState }, args, runtime.toolCallId);
    return new Command({ update: {
      runSupervisorState: state,
      reviewFeedback: null,
      messages: [new ToolMessage({ name: 'adjust_plan', tool_call_id: runtime.toolCallId,
        content: JSON.stringify({ plan: state }),
      })],
    } });
  }, {
    name: 'adjust_plan',
    schema: adjustPlanSchema,
    verboseParsingErrors: true,
    description: '调整计划并返回更新后的事实，由你继续决定下一步。',
  });
}

export type AdjustPlanArgs = z.infer<typeof adjustPlanSchema>;

export function adjustPlan(
  context: SupervisorHandoffContext,
  args: AdjustPlanArgs,
  callId: string,
): RunSupervisorState {
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
    || (executionsForPlanItem(context, task.id).length > 0 && !(reuse && task.id === current?.id)))
    .map(task => task.status === 'completed' ? task : { ...task, status: 'superseded' as const });
  return { goal: args.goal, plan: [...retained, ...args.tasks.map((task, index) => ({
    ...task,
    id: reuse && index === 0 && current ? current.id : identity('task', context.runId, callId, String(index)),
    status: 'pending' as const,
  }))] };
}
