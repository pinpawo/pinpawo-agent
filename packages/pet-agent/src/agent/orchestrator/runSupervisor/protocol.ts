import { z } from 'zod';

export const MAX_OBJECTIVE_CHARS = 120;

export const supervisorTaskSchema = z.object({
  capability: z.string().trim().min(1).max(200),
  // Plan items are displayed as a task list; the full instructions belong to the briefing.
  objective: z.string().trim().min(1).max(MAX_OBJECTIVE_CHARS).describe('The deliverable of this item in one short sentence, like a task title (ideally under 30 Chinese characters or 15 English words). Background, steps, constraints and delivery requirements go into the briefing when delegating.'),
}).strict();

/** Only classifies state-changing tools for sequential invocation and message identity. */
export function isSupervisorControlTool(name: string): boolean {
  return ['submit_plan', 'review_current', 'adjust_plan', 'delegate_capability'].includes(name);
}

export const capabilityExecutionSnapshotSchema = z.object({
  planItemId: z.string().min(1),
  delegationId: z.string().min(1),
  capability: z.string().min(1),
  task: z.string().min(1),
  briefing: z.string().refine(text => text.trim().length > 0),
}).strict();

export type CapabilityExecutionInput = z.infer<typeof capabilityExecutionSnapshotSchema>;
