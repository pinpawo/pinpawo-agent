import { z } from 'zod';

export const supervisorTaskSchema = z.object({
  capability: z.string().trim().min(1).max(200),
  task: z.string().refine(text => text.trim().length > 0).describe('当前任务的完整执行说明与预期交付，运行时会原样注入委派。'),
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
