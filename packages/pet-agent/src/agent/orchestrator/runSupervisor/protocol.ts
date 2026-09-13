import { z } from 'zod';

export type OrchestratorRuntimeFailure = 'checkpoint_incompatible';

export const supervisorTaskSchema = z.object({
  capability: z.string().trim().min(1).max(200),
  task: z.string().trim().min(1).max(2_000).describe('一个可独立验收的交付结果，明确本 task 的范围。仅因依赖前项结果或需要不同 Capability 负责才拆分。'),
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
    reason: z.string().trim().min(1).max(2_000).describe('调整依据：具体执行证据或用户要求，以及为何需要改变后续安排。'),
    currentDelegation: z.enum(['continue', 'replace']).describe('continue：保留当前执行上下文，可修改 task 但必须保持 Capability；replace：更换 Capability 或丢弃旧执行上下文。替换不代表旧任务完成。'),
    tasks: z.array(supervisorTaskSchema).min(1).max(24),
  }).strict() }).strict(),
  z.object({ name: z.literal('execute_current'), args: z.object({
    guidance: z.string().trim().min(1).max(2_000).optional().describe('本次执行需要遵循的补充指导。'),
  }).strict() }).strict(),
]);

export type SupervisorControl = z.infer<typeof controlSchema>;
export const supervisorControlSchemas = {
  submit_plan: controlSchema.options[0].shape.args,
  review_current: controlSchema.options[1].shape.args,
  adjust_plan: controlSchema.options[2].shape.args,
  execute_current: controlSchema.options[3].shape.args,
};

const executionSchema = z.object({
  taskId: z.string().min(1),
  delegationId: z.string().min(1),
  capability: z.string().min(1),
  task: z.string().min(1),
  mode: z.enum(['initial', 'continue']),
  guidance: z.string().nullable(),
}).strict();

// Read compatibility for historical delegation records; never exposed as a model tool.
export const legacyReviewSchema = z.object({ name: z.literal('review_current'), args: z.object({
  completed: z.boolean().optional(), reason: z.string().trim().min(1).max(2_000),
  reply: z.string().trim().min(1).optional(),
}).strict() }).strict();

/** Root's actual tool input, not a second model-selected tool or a pending slot. */
export const capabilityHandoffSchema = z.object({
  control: z.union([controlSchema, legacyReviewSchema]),
  execution: executionSchema,
}).strict();
