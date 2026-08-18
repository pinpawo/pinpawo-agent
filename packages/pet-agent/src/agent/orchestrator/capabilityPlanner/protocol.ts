import { z } from 'zod';
import type { SubagentCompletionReason } from '../../../types/subagent';
import type { CapabilityPlanTask } from '../types';

export const PLANNER_ACTIONS = [
  'continue_current',
  'execute_plan',
  'advance_plan',
  'goal_done',
  'user_input_required',
  'unavailable',
] as const;

export type PlannerAction = typeof PLANNER_ACTIONS[number];
export type PlannerReplyOutcome = Extract<
  PlannerAction,
  'goal_done' | 'user_input_required' | 'unavailable'
>;

/** Deterministic root-visible failure metadata; never produced by a model. */
export type OrchestratorRuntimeFailure =
  | 'checkpoint_incompatible';

/**
 * A parsed terminal Planner action. `tasks` is non-empty exactly for
 * `execute_plan` and `advance_plan`; parsePlannerCommit enforces that pairing,
 * so consumers may read `tasks` directly for those two actions only.
 *
 * `continue_current` deliberately carries no tasks: it keeps the active
 * delegation's task and the remaining plan unchanged. That invariant is not
 * expressible in this shape — it lives in buildContinueCurrentUpdate(), which
 * reuses the existing delegation instead of materializing a new one.
 */
export type PlannerCommit = {
  readonly action: PlannerAction;
  readonly tasks: readonly CapabilityPlanTask[];
};

export type PlannerDelegationInput = {
  readonly delegationId: string;
  readonly transcriptRunId: string;
  readonly capability: string;
  readonly task: string;
};

export type PlannerAnnounceInput = {
  readonly messageId: string | null;
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
  const requiresTasks = commit.action === 'execute_plan'
    || commit.action === 'advance_plan';
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
    || commit.action === 'advance_plan'
    || commit.action === 'goal_done'
  )) {
    throw new Error(`Planner action "${commit.action}" is invalid at entry.`);
  }
  if (context.mode === 'boundary' && commit.action === 'execute_plan') {
    throw new Error('Planner action "execute_plan" is invalid at a boundary.');
  }
  if (commit.action === 'continue_current') {
    const activeDelegation = context.activeDelegation;
    if (!activeDelegation) {
      throw new Error('Planner continue_current requires an active delegation.');
    }
  }
  return {
    action: commit.action,
    tasks: commit.tasks,
  };
}
