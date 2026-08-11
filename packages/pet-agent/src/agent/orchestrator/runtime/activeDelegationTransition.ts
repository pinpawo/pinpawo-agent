import { materializeDelegation } from '../delegationBriefing';
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
 * returns to the private Planner boundary with the new human message available
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
    };
  }

  const latestHumanRequest = readLatestHumanRequest(state.messages)?.trim() ?? '';
  const guidance = latestHumanRequest
    ? clipForPrompt(latestHumanRequest, RESUME_GUIDANCE_MAX_CHARS)
    : null;
  const resumedUserGoal = activeDelegation.userGoal
    ?? state.runUserGoal
    ?? (guidance ? { objective: guidance, context: null } : null);
  const runNextDelegation = buildRunNextDelegation(activeDelegation, guidance);
  const resumedSummaries = resumeRunDelegationSummary(
    state.runDelegationSummaries,
    runNextDelegation,
  );

  if (activeDelegation.status === 'awaiting_decision') {
    return {
      traceId: activeDelegation.traceId ?? activeDelegation.transcriptRunId,
      runUserGoal: resumedUserGoal,
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

  const materializedDelegation = materializeDelegation({
    mode: 'continue',
    lane: activeDelegation.lane,
    runId: activeDelegation.transcriptRunId,
    delegationId: activeDelegation.id,
    task: activeDelegation.task,
    gapNote: guidance,
  });

  return {
    messages: materializedDelegation.laneMessages,
    traceId: activeDelegation.traceId ?? activeDelegation.transcriptRunId,
    runUserGoal: resumedUserGoal,
    runNextDelegation,
    taskActiveDelegation: {
      ...activeDelegation,
      contextSummary: runNextDelegation.contextSummary,
      status: 'pending',
      resultPreview: null,
    },
    runDelegationSummaries: resumedSummaries,
    runLatestDelegationOutcome: null,
  };
}
