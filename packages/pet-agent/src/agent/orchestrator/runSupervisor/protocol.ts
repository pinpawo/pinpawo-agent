import { z } from 'zod';

export type OrchestratorRuntimeFailure = 'checkpoint_incompatible';

export type SupervisorDelegationInput = {
  readonly delegationId: string;
  readonly runId: string;
  readonly capability: string;
  readonly task: string;
};

export const supervisorTaskSchema = z.object({
  capability: z.string().trim().min(1).max(200),
  task: z.string().trim().min(1).max(2_000).describe('一个可独立验收的交付结果，明确本 task 的范围。仅因依赖前项结果或需要不同 Capability 负责才拆分。'),
}).strict();

export const submitPlanSchema = z.object({
  tasks: z.array(supervisorTaskSchema).min(1).max(24),
}).strict();

export const reviewCurrentSchema = z.object({
  completed: z.boolean().describe('当前 delegation 的 task 是否已交付。按当前 task 的范围验收；goal 是方向约束，后续计划尚未完成不构成当前 task 的缺口。'),
  reason: z.string().trim().min(1).max(2_000).describe('completed=true：说明当前 task 的交付证据。false：指出当前 task 范围内的具体缺口，这段文字会原样作为继续执行的反馈。'),
  reply: z.string().refine((text) => text.trim().length > 0, 'Reply must be non-empty.').optional()
    .describe('仅 completed=true 时可用。完整的用户回复，直接结束本轮并保留未来计划；不填则执行下一项。没有剩余计划时必须填写。'),
  remainingPlan: z.array(supervisorTaskSchema).max(24).optional()
    .describe('仅在用户已确认修改未来计划时填写；省略保留原计划，[] 清空未来任务。此参数不替换或结束当前 delegation。'),
}).strict();

export const supervisorCommandSchema = z.discriminatedUnion('action', [
  submitPlanSchema.extend({ action: z.literal('execute_plan') }),
  reviewCurrentSchema.extend({ action: z.literal('review_current') }),
]);

export type SupervisorCommand = z.infer<typeof supervisorCommandSchema>;
export type SupervisorAction = SupervisorCommand['action'];

export function parseSupervisorCommand(
  value: unknown,
  context: {
    mode: 'entry' | 'boundary';
    activeDelegation: SupervisorDelegationInput | null;
    allowedCapabilityNames: readonly string[];
  },
): SupervisorCommand {
  const command = supervisorCommandSchema.parse(value);
  if (context.mode === 'entry' && (command.action !== 'execute_plan')) {
    throw new Error('Entry can only submit a plan without accepting a delegation.');
  }
  if (context.mode === 'boundary' && !context.activeDelegation) {
    throw new Error('Boundary control requires an active delegation.');
  }
  if (context.mode === 'boundary' && command.action === 'execute_plan') {
    throw new Error('submit_plan is only available at Entry.');
  }
  if (command.action === 'review_current') {
    if (!command.completed && command.reply) {
      throw new Error('An incomplete review cannot include a reply; ask the user directly instead.');
    }
    if (command.completed && command.remainingPlan?.length === 0 && !command.reply) {
      throw new Error('A completed review requires a final reply when no planned work remains.');
    }
  }
  const tasks = command.action === 'execute_plan' ? command.tasks : command.remainingPlan ?? [];
  for (const task of tasks) {
    if (!context.allowedCapabilityNames.includes(task.capability)) {
      throw new Error(`Run Supervisor selected "${task.capability}" outside the immutable workspace.`);
    }
  }
  return command;
}
