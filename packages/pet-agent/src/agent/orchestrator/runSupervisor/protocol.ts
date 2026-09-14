import { z } from 'zod';

export type OrchestratorRuntimeFailure = 'checkpoint_incompatible';

export const supervisorTaskSchema = z.object({
  capability: z.string().trim().min(1).max(200),
  task: z.string().refine(text => text.trim().length > 0).describe('当前任务的完整执行说明与预期交付，运行时会原样注入委派。'),
}).strict();

export const controlSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('submit_plan'), args: z.object({
    tasks: z.array(supervisorTaskSchema).min(1).max(24),
  }).strict() }).strict(),
  z.object({ name: z.literal('review_current'), args: z.object({
    completed: z.boolean().describe('是否验收当前任务的最新交付。false 保留任务供后续补做；工具不触发执行。'),
    reason: z.string().trim().min(1).max(2_000).describe('验收依据或尚需补齐的工作。'),
  }).strict() }).strict(),
  z.object({ name: z.literal('adjust_plan'), args: z.object({
    goal: z.string().trim().min(1).max(4_000).describe('没有新用户输入时必须原样保留当前 goal；只有用户明确要求或确认改变目标时才更新。'),
    reason: z.string().trim().min(1).max(2_000).describe('使原计划无法继续适用的具体执行证据或新用户要求，以及本次必要的最小调整。'),
    currentDelegation: z.enum(['continue', 'replace']).describe('continue：保留当前执行上下文，可修改 task 但必须保持 Capability；replace：更换 Capability 或丢弃旧执行上下文。替换不代表旧任务完成。'),
    tasks: z.array(supervisorTaskSchema).min(1).max(24).describe('调整后的剩余工作。已完成事项由运行时保留，不重新提交；continue 时第一项对应保留身份与交付的当前任务。'),
  }).strict() }).strict(),
  z.object({ name: z.literal('delegate_capability'), args: z.object({}).strict() }).strict(),
]);

/** Root's canonical call carries the briefing injected from confirmed plan facts. */
export const capabilityDelegationArgumentsSchema = z.object({
  briefing: z.string().refine(text => text.trim().length > 0),
}).strict();

export type SupervisorControl = z.infer<typeof controlSchema>;
export const supervisorControlSchemas = {
  submit_plan: controlSchema.options[0].shape.args,
  review_current: controlSchema.options[1].shape.args,
  adjust_plan: controlSchema.options[2].shape.args,
  delegate_capability: controlSchema.options[3].shape.args,
};

export const capabilityExecutionSnapshotSchema = z.object({
  taskId: z.string().min(1),
  delegationId: z.string().min(1),
  capability: z.string().min(1),
  task: z.string().min(1),
  mode: z.enum(['initial', 'continue']),
}).strict();
