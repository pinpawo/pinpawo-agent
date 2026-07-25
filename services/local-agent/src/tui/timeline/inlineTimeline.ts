import type { LocalAgentTimelineEntry } from '../../localAgentSession';

export type InlineTimelinePartition = {
  committedEntries: LocalAgentTimelineEntry[];
  liveEntries: LocalAgentTimelineEntry[];
};

export function advanceInlineTimeline(
  previousCommittedEntries: LocalAgentTimelineEntry[],
  entries: LocalAgentTimelineEntry[],
): InlineTimelinePartition {
  const settledPrefix = partitionInlineTimeline(entries).committedEntries;
  const committedIds = new Set(previousCommittedEntries.map((entry) => entry.id));
  const additions = settledPrefix.filter((entry) => !committedIds.has(entry.id));
  const committedEntries = additions.length === 0
    ? previousCommittedEntries
    : [...previousCommittedEntries, ...additions];
  if (additions.length > 0) {
    for (const entry of additions) {
      committedIds.add(entry.id);
    }
  }
  return {
    committedEntries,
    liveEntries: entries.filter((entry) => !committedIds.has(entry.id)),
  };
}

export function partitionInlineTimeline(
  entries: LocalAgentTimelineEntry[],
): InlineTimelinePartition {
  const firstLiveIndex = entries.findIndex((entry) => !isTimelineEntrySettled(entry));
  if (firstLiveIndex < 0) {
    return {
      committedEntries: entries,
      liveEntries: [],
    };
  }
  return {
    committedEntries: entries.slice(0, firstLiveIndex),
    liveEntries: entries.slice(firstLiveIndex),
  };
}

export function isTimelineEntrySettled(entry: LocalAgentTimelineEntry) {
  if (entry.type === 'message') {
    return entry.status === 'completed';
  }
  return entry.phase === 'completed'
    || entry.phase === 'failed'
    || entry.phase === 'interrupted';
}
