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
    // Omit when starting pending work or replying without an acceptance decision.
    completed: z.boolean().optional().describe('true：验收当前任务最新结果中的有效交付；false：立即委派补做，不能与 reply 同用。已有交付且继续调度时必须填写；尚无执行结果时可省略以开始执行。暂缓验收并回复时省略，保持进度。'),
    reason: z.string().trim().min(1).max(2_000).describe('验收依据或继续执行时需要补齐的具体工作。'),
    reply: z.string().trim().min(1).optional().describe('停止本轮执行时给用户的最终答复或必要问题，不是“即将执行”的进度通知。继续执行时必须省略。'),
  }).strict() }).strict(),
  z.object({ name: z.literal('adjust_plan'), args: z.object({
    goal: z.string().trim().min(1).max(4_000).describe('没有新用户输入时必须原样保留当前 goal；只有用户明确要求或确认改变目标时才更新。'),
    reason: z.string().trim().min(1).max(2_000).describe('调整依据：具体执行证据或用户要求，以及为何需要改变后续安排。'),
    currentDelegation: z.enum(['continue', 'replace']).describe('continue：保留当前执行上下文，可修改 task 但必须保持 Capability；replace：更换 Capability 或丢弃旧执行上下文。替换不代表旧任务完成。'),
    tasks: z.array(supervisorTaskSchema).min(1).max(24),
  }).strict() }).strict(),
]);

export type SupervisorControl = z.infer<typeof controlSchema>;
export const supervisorControlSchemas = {
  submit_plan: controlSchema.options[0].shape.args,
  review_current: controlSchema.options[1].shape.args,
  adjust_plan: controlSchema.options[2].shape.args,
};

const executionSchema = z.object({
  taskId: z.string().min(1),
  delegationId: z.string().min(1),
  capability: z.string().min(1),
  task: z.string().min(1),
  mode: z.enum(['initial', 'continue']),
  guidance: z.string().nullable(),
}).strict();

/** Root's actual tool input, not a second model-selected tool or a pending slot. */
export const capabilityHandoffSchema = z.object({
  control: controlSchema,
  execution: executionSchema,
}).strict();
