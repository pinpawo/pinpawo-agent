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
    completed: z.boolean().optional().describe('true：依据当前任务最新工具结果中的有效交付验收；false：立即委派执行器补齐它能自行完成的工作，不是等待用户。暂不验收、需要用户信息时省略 completed 并填写 reply，保留当前进度且不执行；也可直接自然语言提问。当前任务尚无执行结果时可省略 completed 直接推进。'),
    reason: z.string().trim().min(1).max(2_000).describe('验收依据或继续执行时需要补齐的具体工作。'),
    reply: z.string().trim().min(1).optional().describe('仅在本轮停止执行、向用户交付最终答复或等待必要输入时填写。填写后不会执行任何后续任务。要继续当前任务或执行下一项必须省略；不得填写“即将执行”的进度通知；不能与 completed=false 同用。'),
  }).strict() }).strict(),
  z.object({ name: z.literal('adjust_plan'), args: z.object({
    goal: z.string().trim().min(1).max(4_000),
    reason: z.string().trim().min(1).max(2_000),
    currentDelegation: z.enum(['continue', 'replace']),
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
