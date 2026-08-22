import {
  applySessionSnapshot,
  type AgentSession,
  type AgentSessionSnapshot,
} from '@pinpawo/agent-session';
import {
  reconcileCompletionSnapshot,
  reconcileCompletionSnapshotMetadata,
} from './completionSnapshot';

export type SessionSnapshotReason =
  | 'startup'
  | 'reconnect'
  | 'completion'
  | 'completion-metadata';

export function reconcileSessionSnapshot(
  live: AgentSession,
  snapshot: AgentSessionSnapshot,
  reason: SessionSnapshotReason,
  observedAt: number,
): AgentSession {
  if (reason === 'completion') {
    return reconcileCompletionSnapshot(live, snapshot, observedAt);
  }
  if (reason === 'completion-metadata') {
    return reconcileCompletionSnapshotMetadata(live, snapshot, observedAt);
  }
  return applySessionSnapshot(live, snapshot, {
    observedAt,
    preserveOmittedTokenUsage: reason !== 'startup',
    preserveOmittedSessionTokenUsage: reason !== 'startup',
  });
}
