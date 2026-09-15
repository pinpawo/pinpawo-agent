import { z } from 'zod';

export const supervisorTaskSchema = z.object({
  capability: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).describe('本项要达成的目标。只描述结果，不提前展开背景、执行步骤或完整交付要求。'),
}).strict();

/** Only classifies state-changing tools for sequential invocation and message identity. */
export function isSupervisorControlTool(name: string): boolean {
  return ['submit_plan', 'review_current', 'adjust_plan', 'delegate_capability'].includes(name);
}

export const capabilityExecutionSnapshotSchema = z.object({
  taskId: z.string().min(1),
  delegationId: z.string().min(1),
  capability: z.string().min(1),
  task: z.string().min(1),
  mode: z.enum(['initial', 'continue']),
  briefing: z.string().refine(text => text.trim().length > 0),
}).strict();

export type CapabilityExecutionInput = z.infer<typeof capabilityExecutionSnapshotSchema>;
