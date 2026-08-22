import {
  applySessionSnapshot,
  type AgentMessageEntry,
  type AgentSession,
  type AgentSessionSnapshot,
  type AgentTimelineEntry,
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
  if (
    live.activeRun
    || hasCanonicalOperationEntries(applied.timeline)
  ) {
    return live.activeRun
      ? mergeCompletionSnapshotMetadata(live, applied)
      : applied;
  }
  // Checkpoints persist the conversation spine and canonical subagent handoffs,
  // while operation and system entries still exist only in the live projection.
  // Replace checkpoint-owned messages without discarding those settled details.
  return {
    ...applied,
    timeline: mergeCheckpointMessagesWithLiveDetails(
      live.timeline,
      applied.timeline,
    ),
  };
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

function mergeCheckpointMessagesWithLiveDetails(
  live: readonly AgentTimelineEntry[],
  checkpoint: readonly AgentTimelineEntry[],
) {
  const checkpointMessages = checkpoint.filter(isCheckpointMessage);
  const liveMessages = live.filter(isCheckpointMessage);
  const reconciledMessages = reconcileCheckpointMessages(
    checkpointMessages,
    liveMessages,
  );
  const replacements = new Map(
    reconciledMessages.flatMap(({ message, liveIndex }) => (
      liveIndex >= 0 ? [[liveMessages[liveIndex]!, message] as const] : []
    )),
  );
  const insertionsBefore = new Map<AgentMessageEntry, AgentMessageEntry[]>();
  let pendingInsertions: AgentMessageEntry[] = [];
  for (const reconciled of reconciledMessages) {
    if (reconciled.liveIndex < 0) {
      pendingInsertions.push(reconciled.message);
      continue;
    }
    if (pendingInsertions.length > 0) {
      insertionsBefore.set(
        liveMessages[reconciled.liveIndex]!,
        pendingInsertions,
      );
      pendingInsertions = [];
    }
  }
  const timeline: AgentTimelineEntry[] = [];
  for (const entry of live) {
    if (isCheckpointMessage(entry)) {
      timeline.push(...(insertionsBefore.get(entry) ?? []));
    }
    const replacement = isCheckpointMessage(entry)
      ? replacements.get(entry)
      : undefined;
    if (replacement) {
      timeline.push(replacement);
      continue;
    }
    if (isSettledSupplementaryEntry(entry)) {
      timeline.push(entry);
    }
  }
  timeline.push(...pendingInsertions);
  return timeline;
}

function isCheckpointMessage(
  entry: AgentTimelineEntry,
): entry is AgentMessageEntry {
  return entry.type === 'message'
    && entry.role !== 'system';
}

function reconcileCheckpointMessages(
  checkpoint: readonly AgentMessageEntry[],
  live: readonly AgentMessageEntry[],
) {
  let liveIndex = 0;
  return checkpoint.map((message) => {
    const exactIndex = live.findIndex((candidate, index) => (
      index >= liveIndex
      && candidate.role === message.role
      && checkpointMessageTextMatchesLive(message, candidate)
    ));
    const matchingIndex = exactIndex >= 0
      ? exactIndex
      : live.findIndex((candidate, index) => (
        index >= liveIndex && candidate.role === message.role
      ));
    if (matchingIndex < 0) {
      return { message, liveIndex: -1 };
    }
    liveIndex = matchingIndex + 1;
    const matched = live[matchingIndex]!;
    return {
      message: matched.requestId
        ? { ...message, requestId: matched.requestId }
        : message,
      liveIndex: matchingIndex,
    };
  });
}

function isSettledSupplementaryEntry(entry: AgentTimelineEntry) {
  return entry.type === 'message'
    ? entry.status === 'completed'
    : entry.phase === 'completed'
      || entry.phase === 'failed'
      || entry.phase === 'interrupted';
}

function checkpointMessageTextMatchesLive(
  checkpoint: AgentMessageEntry,
  live: AgentMessageEntry,
) {
  return checkpoint.text === live.text
    || (
      checkpoint.role === 'subagent'
      && checkpoint.text.startsWith(live.text)
    );
}

function hasCanonicalOperationEntries(
  timeline: readonly AgentTimelineEntry[],
) {
  return timeline.some((entry) => entry.type === 'operation');
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
