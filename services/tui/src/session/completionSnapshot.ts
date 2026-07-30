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
  if (live.activeRun || hasSupplementaryTimelineEntries(applied.timeline)) {
    return live.activeRun
      ? mergeCompletionSnapshotMetadata(live, applied)
      : applied;
  }
  // Checkpoints currently persist the conversation message spine, while
  // operation, subagent, and system entries exist only in the live projection.
  // Replace checkpoint-owned messages without discarding those settled details.
  return {
    ...applied,
    timeline: mergeCheckpointMessagesWithLiveDetails(
      live.timeline,
      applied.timeline,
    ),
  };
}

function mergeCheckpointMessagesWithLiveDetails(
  live: readonly AgentTimelineEntry[],
  checkpoint: readonly AgentTimelineEntry[],
) {
  const checkpointMessages = checkpoint.filter(isConversationMessage);
  const liveMessages = live.filter(isConversationMessage);
  const reconciledMessages = reconcileMessageRequestIds(
    checkpointMessages,
    liveMessages,
  );
  const detailsByMessageSlot = Array.from(
    { length: checkpointMessages.length + 1 },
    () => [] as AgentTimelineEntry[],
  );
  let messageSlot = 0;
  for (const entry of live) {
    if (isConversationMessage(entry)) {
      messageSlot = Math.min(
        messageSlot + 1,
        checkpointMessages.length,
      );
      continue;
    }
    if (isSettledSupplementaryEntry(entry)) {
      detailsByMessageSlot[messageSlot]!.push(entry);
    }
  }

  return reconciledMessages.flatMap((message, index) => [
    ...detailsByMessageSlot[index]!,
    message,
    ...(index === checkpointMessages.length - 1
      ? detailsByMessageSlot[index + 1]!
      : []),
  ]);
}

function isConversationMessage(
  entry: AgentTimelineEntry,
): entry is AgentMessageEntry {
  return entry.type === 'message'
    && (entry.role === 'user' || entry.role === 'assistant');
}

function reconcileMessageRequestIds(
  checkpoint: readonly AgentMessageEntry[],
  live: readonly AgentMessageEntry[],
) {
  let liveIndex = 0;
  return checkpoint.map((message) => {
    const exactIndex = live.findIndex((candidate, index) => (
      index >= liveIndex
      && candidate.role === message.role
      && candidate.text === message.text
    ));
    const matchingIndex = exactIndex >= 0
      ? exactIndex
      : live.findIndex((candidate, index) => (
        index >= liveIndex && candidate.role === message.role
      ));
    if (matchingIndex < 0) return message;
    liveIndex = matchingIndex + 1;
    const matched = live[matchingIndex]!;
    return matched.requestId
      ? { ...message, requestId: matched.requestId }
      : message;
  });
}

function isSettledSupplementaryEntry(entry: AgentTimelineEntry) {
  return entry.type === 'message'
    ? entry.status === 'completed'
    : entry.phase === 'completed'
      || entry.phase === 'failed'
      || entry.phase === 'interrupted';
}

function hasSupplementaryTimelineEntries(
  timeline: readonly AgentTimelineEntry[],
) {
  return timeline.some((entry) => !isConversationMessage(entry));
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
