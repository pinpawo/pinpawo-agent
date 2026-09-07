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
  task: z.string().trim().min(1).max(2_000),
}).strict();

export const submitPlanSchema = z.object({
  tasks: z.array(supervisorTaskSchema).min(1).max(24),
}).strict();

export const continueCurrentSchema = z.object({
  feedback: z.string().trim().min(1).max(2_000).optional(),
  remainingPlan: z.array(supervisorTaskSchema).max(24).optional(),
}).strict();

export const acceptResultSchema = z.object({
  reply: z.string().refine((text) => text.trim().length > 0, 'Reply must be non-empty.').optional(),
  remainingPlan: z.array(supervisorTaskSchema).max(24).optional(),
}).strict();

export const supervisorCommandSchema = z.discriminatedUnion('action', [
  submitPlanSchema.extend({ action: z.literal('execute_plan') }),
  continueCurrentSchema.extend({ action: z.literal('continue_current') }),
  acceptResultSchema.extend({ action: z.literal('accept_result') }),
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
  if (command.action === 'accept_result' && command.remainingPlan?.length === 0 && !command.reply) {
    throw new Error('accept_result requires a final reply when no planned work remains.');
  }
  const tasks = command.action === 'execute_plan' ? command.tasks : command.remainingPlan ?? [];
  for (const task of tasks) {
    if (!context.allowedCapabilityNames.includes(task.capability)) {
      throw new Error(`Run Supervisor selected "${task.capability}" outside the immutable workspace.`);
    }
  }
  return command;
}
