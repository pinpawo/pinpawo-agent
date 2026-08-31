import { z } from 'zod';
import type { SubagentCompletionReason } from '../../../types/subagent';
import type { CapabilityPlanTask } from '../types';

export const SUPERVISOR_ACTIONS = [
  'continue_current',
  'execute_plan',
  'advance_plan',
  'goal_done',
  'user_input_required',
  'unavailable',
] as const;

export type SupervisorAction = typeof SUPERVISOR_ACTIONS[number];
export type SupervisorReplyOutcome = Extract<
  SupervisorAction,
  'goal_done' | 'user_input_required' | 'unavailable'
>;

/** Root-owned terminal route outcomes, including the explicit protocol failure. */
export type SupervisorRouteOutcome = SupervisorReplyOutcome | 'supervisor_command_missing';

/** Deterministic root-visible failure metadata; never produced by a model. */
export type OrchestratorRuntimeFailure =
  | 'checkpoint_incompatible';

export type SupervisorUserInputRequest = {
  readonly question: string;
};

/**
 * A parsed Supervisor command. `tasks` is non-empty exactly for
 * `execute_plan` and `advance_plan`; parseSupervisorCommand enforces that pairing,
 * so consumers may read `tasks` directly for those two actions only.
 *
 * `continue_current` deliberately carries no tasks: it keeps the active
 * delegation's task and the remaining plan unchanged. That invariant is not
 * expressible in this shape — it lives in buildContinueCurrentUpdate(), which
 * reuses the existing delegation instead of materializing a new one.
 */
export type SupervisorCommand = {
  readonly action: SupervisorAction;
  readonly tasks: readonly CapabilityPlanTask[];
  readonly userInputRequest?: SupervisorUserInputRequest;
};

export type SupervisorDelegationInput = {
  readonly delegationId: string;
  readonly runId: string;
  readonly capability: string;
  readonly task: string;
};

export type SupervisorAnnounceInput = {
  readonly messageId: string;
  readonly completionReason: SubagentCompletionReason;
  readonly result: string;
};

/** Identity of the newest announce currently being evaluated. */
export type SupervisorAnnounceTarget = Omit<SupervisorAnnounceInput, 'result'> & {
  /** Optional compatibility echo; ordered announceAttempts owns the evidence. */
  readonly result?: string;
};

const supervisorTaskSchema = z.object({
  capability: z.string().trim().min(1).max(200),
  task: z.string().trim().min(1).max(2_000),
}).strict();

const supervisorUserInputRequestSchema = z.object({
  question: z.string().trim().min(1).max(1_000),
}).strict();

export const supervisorCommandSchema = z.object({
  action: z.enum(SUPERVISOR_ACTIONS),
  tasks: z.array(supervisorTaskSchema).max(24),
  userInputRequest: supervisorUserInputRequestSchema.optional(),
}).strict();

export function parseSupervisorCommand(
  value: unknown,
  context: {
    mode: 'entry' | 'boundary';
    activeDelegation: SupervisorDelegationInput | null;
    allowedCapabilityNames: readonly string[];
  },
): SupervisorCommand {
  const command = supervisorCommandSchema.parse(value);
  const requiresTasks = command.action === 'execute_plan'
    || command.action === 'advance_plan';
  if (requiresTasks !== (command.tasks.length > 0)) {
    throw new Error(
      `Supervisor action "${command.action}" ${requiresTasks ? 'requires' : 'forbids'} tasks.`,
    );
  }
  const requiresUserInputRequest = command.action === 'user_input_required';
  if (requiresUserInputRequest !== Boolean(command.userInputRequest)) {
    throw new Error(
      `Supervisor action "${command.action}" ${requiresUserInputRequest ? 'requires' : 'forbids'} userInputRequest.`,
    );
  }
  for (const task of command.tasks) {
    if (!context.allowedCapabilityNames.includes(task.capability)) {
      throw new Error(
        `Run Supervisor selected "${task.capability}" outside the immutable workspace.`,
      );
    }
  }
  if (context.mode === 'entry' && (
    command.action === 'continue_current'
    || command.action === 'advance_plan'
    || command.action === 'goal_done'
  )) {
    throw new Error(`Supervisor action "${command.action}" is invalid at entry.`);
  }
  if (context.mode === 'boundary' && command.action === 'execute_plan') {
    throw new Error('Supervisor action "execute_plan" is invalid at a boundary.');
  }
  if (command.action === 'continue_current') {
    const activeDelegation = context.activeDelegation;
    if (!activeDelegation) {
      throw new Error('Supervisor continue_current requires an active delegation.');
    }
  }
  return {
    action: command.action,
    tasks: command.tasks,
    ...(command.userInputRequest
      ? { userInputRequest: command.userInputRequest }
      : {}),
  };
}
