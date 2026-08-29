import {
  resumeRunDelegationSummary,
  updateRunDelegationSummaryResult,
} from '../delegations';
import { readLatestHumanRequest } from '../messageLanes';
import type { OrchestratorStateType } from '../state';
import type { RunNextDelegation, TaskActiveDelegation } from '../types';
import { clipForPrompt } from '../utils';

const RESUME_GUIDANCE_MAX_CHARS = 2_000;

function buildRunNextDelegation(
  activeDelegation: TaskActiveDelegation,
  guidance: string | null,
): RunNextDelegation {
  return {
    id: activeDelegation.id,
    lane: activeDelegation.lane,
    mode: 'continue',
    task: activeDelegation.task,
    contextSummary: guidance
      ?? activeDelegation.contextSummary
      ?? '继续完成当前 delegated task。',
  };
}

/**
 * Applies the caller-owned fresh-turn decision to an unfinished delegation.
 *
 * Superseding only detaches the active pointer. It intentionally leaves every
 * lane message in checkpoint storage so interruption never fabricates a
 * completed handoff or destroys resumable evidence.
 *
 * Resuming reuses the exact delegation and transcript identities. A pending
 * delegation can return directly to its capability; an awaiting delegation
 * returns to the Planner boundary with the new human message available
 * as guidance.
 */
export function applyActiveDelegationTransition(
  state: OrchestratorStateType,
): Partial<OrchestratorStateType> {
  const activeDelegation = state.taskActiveDelegation;
  if (!activeDelegation) {
    return {};
  }

  if (state.runActiveDelegationTransition === 'supersede_active') {
    return {
      taskActiveDelegation: null,
      taskPlannerContinuation: null,
    };
  }

  if (!isResumableDelegation(activeDelegation)) {
    return {
      runNextDelegation: null,
      runPlannerSession: null,
      taskPlannerContinuation: null,
      runTerminalOutcome: { kind: 'checkpoint_incompatible' },
    };
  }

  const latestHumanRequest = readLatestHumanRequest(state.messages)?.trim() ?? '';
  const guidance = latestHumanRequest
    ? clipForPrompt(latestHumanRequest, RESUME_GUIDANCE_MAX_CHARS)
    : null;
  const resumedUserRequest = activeDelegation.userRequest;
  const continuation = state.taskPlannerContinuation
    ?? (state.runPlannerSession && state.runPlannerSession.runId !== state.runId
      ? {
          traceId: activeDelegation.traceId,
          userRequest: activeDelegation.userRequest,
          activeDelegationId: activeDelegation.id,
          remainingPlan: [...state.runPlannerSession.plan],
        }
      : null);
  const runNextDelegation = buildRunNextDelegation(activeDelegation, guidance);
  const resumedSummaries = resumeRunDelegationSummary(
    state.runDelegationSummaries,
    runNextDelegation,
  );

  if (activeDelegation.status === 'awaiting_decision') {
    return {
      traceId: activeDelegation.traceId,
      runPlannerSession: null,
      taskPlannerContinuation: continuation,
      runUserRequest: resumedUserRequest,
      runDelegationSummaries: updateRunDelegationSummaryResult(
        resumedSummaries,
        activeDelegation.id,
        {
          status: 'progress',
          resultPreview: activeDelegation.resultPreview,
        },
      ),
    };
  }

  return {
    traceId: activeDelegation.traceId,
    runPlannerSession: null,
    taskPlannerContinuation: continuation,
    runUserRequest: resumedUserRequest,
    runNextDelegation,
    taskActiveDelegation: {
      ...activeDelegation,
      contextSummary: runNextDelegation.contextSummary,
      status: 'pending',
      resultPreview: null,
    },
    runDelegationSummaries: resumedSummaries,
    runTerminalOutcome: null,
  };
}

function isResumableDelegation(
  value: TaskActiveDelegation,
): value is TaskActiveDelegation & { traceId: string; userRequest: string } {
  return typeof value.traceId === 'string'
    && value.traceId.trim().length > 0
    && typeof value.userRequest === 'string'
    && value.userRequest.trim().length > 0;
}
