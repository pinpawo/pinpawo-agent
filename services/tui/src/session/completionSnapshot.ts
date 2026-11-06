import {
  applySessionSnapshot,
  type AgentSession,
  type AgentSessionSnapshot,
} from '@pinpawo/agent-session';

export function reconcileCompletionSnapshot(
  live: AgentSession,
  snapshot: AgentSessionSnapshot,
  observedAt: number,
) {
  const applied = applySessionSnapshot(live, snapshot, {
    observedAt,
    preserveOmittedTokenUsage: true,
    preserveOmittedSessionTokenUsage: true,
  });
  // A completion snapshot owns the projection it covers, including omissions.
  // A request made for an older run must not replace a newer active timeline.
  return live.activeRun
    ? mergeCompletionSnapshotMetadata(live, applied)
    : applied;
}

export function reconcileCompletionSnapshotMetadata(
  live: AgentSession,
  snapshot: AgentSessionSnapshot,
  observedAt: number,
) {
  return mergeCompletionSnapshotMetadata(
    live,
    applySessionSnapshot(live, snapshot, {
      observedAt,
      preserveOmittedTokenUsage: true,
      preserveOmittedSessionTokenUsage: true,
    }),
  );
}

function mergeCompletionSnapshotMetadata(
  live: AgentSession,
  snapshot: AgentSession,
): AgentSession {
  return {
    ...live,
    ...(snapshot.actor ? { actor: snapshot.actor } : {}),
    ...(snapshot.runtime ? { runtime: snapshot.runtime } : {}),
    ...(snapshot.sessionTokenUsage
      ? { sessionTokenUsage: snapshot.sessionTokenUsage }
      : {}),
  };
}
