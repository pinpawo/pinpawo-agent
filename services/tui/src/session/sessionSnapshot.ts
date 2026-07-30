import {
  applySessionSnapshot,
  type AgentSession,
  type AgentSessionSnapshot,
} from '@pinpawo/agent-session';
import { reconcileCompletionSnapshot } from './completionSnapshot';

export type SessionSnapshotReason = 'startup' | 'reconnect' | 'completion';

export function reconcileSessionSnapshot(
  live: AgentSession,
  snapshot: AgentSessionSnapshot,
  reason: SessionSnapshotReason,
  observedAt: number,
): AgentSession {
  if (reason === 'completion') {
    return reconcileCompletionSnapshot(live, snapshot, observedAt);
  }
  return applySessionSnapshot(live, snapshot, {
    observedAt,
    preserveOmittedTokenUsage: reason !== 'startup',
    preserveOmittedSessionTokenUsage: reason !== 'startup',
  });
}
