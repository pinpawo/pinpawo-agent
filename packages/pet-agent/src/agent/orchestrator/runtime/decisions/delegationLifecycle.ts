import {
  readLatestAnnounce,
} from '../../messageLanes';
import type { OrchestratorStateType } from '../../state';
import type {
  DecisionMode,
  MessageLane,
  RunNextDelegation,
  TaskActiveDelegation,
} from '../../types';

export function decisionModeFromRunNextDelegation(pending: RunNextDelegation | null): DecisionMode {
  if (!pending) return 'answer';
  return pending.lane === 'general' ? 'general' : 'capability';
}

export function createTaskActiveDelegation(
  delegation: RunNextDelegation,
  runId: string,
): TaskActiveDelegation {
  return {
    id: delegation.id,
    lane: delegation.lane,
    task: delegation.task,
    contextSummary: delegation.contextSummary,
    transcriptRunId: runId,
    status: 'pending',
    resultPreview: null,
  };
}

export function recoverTaskActiveDelegationFromRunState(
  state: OrchestratorStateType,
): TaskActiveDelegation | null {
  // Legacy checkpoint recovery for checkpoints written before taskActiveDelegation
  // existed. Remove once old checkpoints have aged out or at the next checkpoint
  // incompatibility boundary.
  if (state.taskActiveDelegation || !state.runId) {
    return null;
  }
  for (let index = state.runDelegationSummaries.length - 1; index >= 0; index -= 1) {
    const delegation = state.runDelegationSummaries[index];
    if (delegation.status !== 'progress' && delegation.status !== 'completed') {
      continue;
    }
    const announce = readLatestAnnounce(state.messages, {
      runId: state.runId,
      delegationId: delegation.id,
    });
    if (!announce) {
      continue;
    }
    return {
      id: delegation.id,
      lane: delegation.lane,
      task: delegation.task,
      contextSummary: null,
      transcriptRunId: state.runId,
      status: 'awaiting_decision',
      resultPreview: delegation.resultPreview,
    };
  }
  return null;
}

export function resolveDelegationTranscriptRunId(
  state: OrchestratorStateType,
  delegation: RunNextDelegation,
) {
  return state.taskActiveDelegation?.id === delegation.id
    ? state.taskActiveDelegation.transcriptRunId
    : state.runId;
}

export function readCapabilityNameFromLane(lane: MessageLane): string | null {
  return lane.startsWith('capability:') ? lane.slice('capability:'.length) : null;
}
