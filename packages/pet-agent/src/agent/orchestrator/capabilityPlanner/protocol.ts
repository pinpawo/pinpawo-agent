import { z } from 'zod';
import type { SubagentCompletionReason } from '../../../types/subagent';
import type { CapabilityPlanTask } from '../types';

export const PLANNER_ACTIONS = [
  'continue_current',
  'execute_plan',
  'goal_done',
  'user_input_required',
  'unavailable',
] as const;

export type PlannerAction = typeof PLANNER_ACTIONS[number];
export type PlannerReplyOutcome = Extract<
  PlannerAction,
  'goal_done' | 'user_input_required' | 'unavailable'
>;

/** Deterministic root-visible failure metadata; never produced by the model. */
export type PlannerRuntimeFailure = 'checkpoint_missing';

export type PlannerCommit = {
  readonly action: PlannerAction;
  readonly tasks: readonly CapabilityPlanTask[];
};

export type PlannerDelegationInput = {
  readonly delegationId: string;
  readonly capability: string;
  readonly task: string;
};

export type PlannerAnnounceInput = {
  readonly messageId: string | null;
  readonly text: string | null;
  readonly completionReason: SubagentCompletionReason | null;
};

const plannerTaskSchema = z.object({
  capability: z.string().trim().min(1).max(200),
  task: z.string().trim().min(1).max(2_000),
}).strict();

export const plannerCommitSchema = z.object({
  action: z.enum(PLANNER_ACTIONS),
  tasks: z.array(plannerTaskSchema).max(24),
}).strict();

export function parsePlannerCommit(
  value: unknown,
  context: {
    mode: 'entry' | 'boundary';
    activeDelegation: PlannerDelegationInput | null;
    allowedCapabilityNames: readonly string[];
  },
): PlannerCommit {
  const commit = plannerCommitSchema.parse(value);
  const requiresTasks = commit.action === 'continue_current'
    || commit.action === 'execute_plan';
  if (requiresTasks !== (commit.tasks.length > 0)) {
    throw new Error(
      `Planner action "${commit.action}" ${requiresTasks ? 'requires' : 'forbids'} tasks.`,
    );
  }
  for (const task of commit.tasks) {
    if (!context.allowedCapabilityNames.includes(task.capability)) {
      throw new Error(
        `Capability Planner selected "${task.capability}" outside the immutable workspace.`,
      );
    }
  }
  if (context.mode === 'entry' && (
    commit.action === 'continue_current'
    || commit.action === 'goal_done'
  )) {
    throw new Error(`Planner action "${commit.action}" is invalid at entry.`);
  }
  if (commit.action === 'continue_current') {
    const activeDelegation = context.activeDelegation;
    if (!activeDelegation) {
      throw new Error('Planner continue_current requires an active delegation.');
    }
    if (commit.tasks[0]?.capability !== activeDelegation.capability) {
      throw new Error(
        'Planner continue_current must keep the active delegation capability.',
      );
    }
  }
  return commit;
}
