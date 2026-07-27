import {
  TextRenderable,
  type CliRenderer,
  type ScrollbackSurface,
} from '@opentui/core';
import type {
  AgentSession,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';
import {
  countSettledTimelinePrefix,
  formatTimelineEntry,
} from './timelineModel';

type ActiveStreamingSurface = {
  surface: ScrollbackSurface;
  text: TextRenderable;
  entryKey: string;
  committedRows: number;
};

export type TimelineReconciliationCache = {
  prefixLength: number;
  tailEntry: AgentTimelineEntry | null;
};

export const MAX_SETTLED_ENTRIES_PER_COMMIT = 200;

export class TimelineScrollback {
  private welcomeRendered = false;
  private sessionId: string | null = null;
  private committedFingerprints: string[] = [];
  private reconciliationCache: TimelineReconciliationCache = {
    prefixLength: 0,
    tailEntry: null,
  };
  private activeStreamingSurface: ActiveStreamingSurface | null = null;

  constructor(private readonly renderer: CliRenderer) {}

  renderWelcome(lines: readonly string[]) {
    if (this.welcomeRendered || lines.length === 0) return;
    this.renderer.writeToScrollback((context) => {
      const text = new TextRenderable(context.renderContext, {
        id: 'pinpawo-welcome',
        width: context.width,
        height: lines.length,
        content: lines.join('\n'),
        fg: '#69c0c8',
      });
      return {
        root: text,
        width: context.width,
        height: lines.length,
      };
    });
    this.welcomeRendered = true;
  }

  render(session: AgentSession) {
    if (session.sessionId !== this.sessionId) {
      const previousSessionId = this.sessionId;
      this.destroyStreamingSurface();
      this.sessionId = session.sessionId;
      this.committedFingerprints = [];
      this.reconciliationCache = {
        prefixLength: 0,
        tailEntry: null,
      };
      if (previousSessionId && previousSessionId !== 'pending') {
        this.writeSessionSeparator(session.sessionId);
      }
    }

    const reconciliation = reconcileTimelinePrefix(
      session.timeline,
      this.committedFingerprints,
      this.reconciliationCache,
    );
    let firstUncommitted = reconciliation.firstUncommitted;
    this.reconciliationCache = reconciliation.cache;
    const settledEnd = countSettledTimelinePrefix(
      session.timeline,
      firstUncommitted,
    );

    const firstEntry = session.timeline[firstUncommitted];
    if (this.activeStreamingSurface) {
      if (
        firstEntry?.type === 'message'
        && streamingEntryKey(firstEntry) === this.activeStreamingSurface.entryKey
      ) {
        if (firstEntry.status === 'completed') {
          this.renderStreamingEntry(firstEntry, true);
          this.committedFingerprints.push(timelineFingerprint(firstEntry));
          this.destroyStreamingSurface();
          firstUncommitted += 1;
        }
      } else {
        this.destroyStreamingSurface();
      }
    }

    for (const [start, end] of planSettledTimelineCommits(
      firstUncommitted,
      settledEnd,
    )) {
      this.commitSettledEntries(session.timeline.slice(start, end));
    }
    this.reconciliationCache = timelineReconciliationCache(
      session.timeline,
      settledEnd,
    );

    const pendingEntry = session.timeline[settledEnd];
    if (pendingEntry?.type === 'message' && pendingEntry.status === 'streaming') {
      this.renderStreamingEntry(pendingEntry, false);
    } else if (this.activeStreamingSurface) {
      this.destroyStreamingSurface();
    }
  }

  destroy() {
    this.destroyStreamingSurface();
  }

  private destroyStreamingSurface() {
    if (
      this.activeStreamingSurface
      && !this.activeStreamingSurface.surface.isDestroyed
    ) {
      this.activeStreamingSurface.surface.destroy();
    }
    this.activeStreamingSurface = null;
  }

  private commitSettledEntries(entries: readonly AgentTimelineEntry[]) {
    if (entries.length === 0) return;
    const surface = this.renderer.createScrollbackSurface({ startOnNewLine: true });
    const text = new TextRenderable(surface.renderContext, {
      id: 'timeline-settled',
      width: '100%',
      height: 'auto',
      content: joinEntries(entries),
    });
    try {
      surface.root.add(text);
      surface.render();

      const settledRows = text.height;
      if (typeof settledRows !== 'number' || settledRows < 1) {
        throw new Error('OpenTUI did not measure settled timeline rows');
      }
      surface.commitRows(0, settledRows);
      this.committedFingerprints.push(...entries.map(timelineFingerprint));
    } finally {
      surface.destroy();
    }
  }

  private renderStreamingEntry(
    entry: Extract<AgentTimelineEntry, { type: 'message' }>,
    completed: boolean,
  ) {
    const entryKey = streamingEntryKey(entry);
    let active = this.activeStreamingSurface;
    if (!active || active.entryKey !== entryKey || active.surface.isDestroyed) {
      this.destroyStreamingSurface();
      const surface = this.renderer.createScrollbackSurface({ startOnNewLine: true });
      const text = new TextRenderable(surface.renderContext, {
        id: `timeline-streaming-${entry.id}`,
        width: '100%',
        height: 'auto',
        content: '',
      });
      surface.root.add(text);
      active = {
        surface,
        text,
        entryKey,
        committedRows: 0,
      };
      this.activeStreamingSurface = active;
    }

    try {
      active.text.content = formatTimelineEntry(entry);
      active.surface.render();
      const stableRows = completed
        ? active.surface.height
        : Math.max(0, active.surface.height - 1);
      if (stableRows > active.committedRows) {
        active.surface.commitRows(active.committedRows, stableRows);
        active.committedRows = stableRows;
      }
    } catch (error) {
      this.destroyStreamingSurface();
      throw error;
    }
  }

  private writeSessionSeparator(sessionId: string) {
    this.renderer.writeToScrollback((context) => {
      const content = `\n── session ${sessionId} ──`;
      const text = new TextRenderable(context.renderContext, {
        id: `session-${sessionId}`,
        width: context.width,
        height: 2,
        content,
        fg: '#8a8a8a',
      });
      return {
        root: text,
        width: context.width,
        height: 2,
      };
    });
  }
}

export function findFirstUncommittedEntry(
  timeline: readonly AgentTimelineEntry[],
  committedFingerprints: readonly string[],
) {
  let committedCursor = 0;
  for (let index = 0; index < timeline.length; index += 1) {
    const fingerprint = timelineFingerprint(timeline[index]!);
    const match = committedFingerprints.indexOf(fingerprint, committedCursor);
    if (match < 0) {
      return index;
    }
    committedCursor = match + 1;
  }
  return timeline.length;
}

export function reconcileTimelinePrefix(
  timeline: readonly AgentTimelineEntry[],
  committedFingerprints: readonly string[],
  cache: TimelineReconciliationCache,
) {
  if (
    cache.prefixLength > 0
    && cache.prefixLength <= timeline.length
    && timeline[cache.prefixLength - 1] === cache.tailEntry
  ) {
    return {
      firstUncommitted: cache.prefixLength,
      cache,
      strategy: 'identity' as const,
    };
  }

  const firstUncommitted = findFirstUncommittedEntry(
    timeline,
    committedFingerprints,
  );
  return {
    firstUncommitted,
    cache: timelineReconciliationCache(timeline, firstUncommitted),
    strategy: 'fingerprint' as const,
  };
}

export function planSettledTimelineCommits(
  start: number,
  end: number,
  maxEntries = MAX_SETTLED_ENTRIES_PER_COMMIT,
) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('maxEntries must be a positive integer');
  }
  const ranges: Array<readonly [number, number]> = [];
  for (let cursor = start; cursor < end; cursor += maxEntries) {
    ranges.push([cursor, Math.min(cursor + maxEntries, end)]);
  }
  return ranges;
}

export function timelineFingerprint(entry: AgentTimelineEntry) {
  if (entry.type === 'message') {
    return JSON.stringify([
      'message',
      entry.role,
      normalizeText(entry.text),
      entry.status,
    ]);
  }
  return JSON.stringify([
    'operation',
    entry.kind,
    normalizeText(entry.title),
    normalizeText(entry.target ?? ''),
    normalizeText(entry.summary ?? ''),
    entry.phase,
  ]);
}

function timelineReconciliationCache(
  timeline: readonly AgentTimelineEntry[],
  prefixLength: number,
): TimelineReconciliationCache {
  return {
    prefixLength,
    tailEntry: prefixLength > 0
      ? timeline[prefixLength - 1] ?? null
      : null,
  };
}

function streamingEntryKey(
  entry: Extract<AgentTimelineEntry, { type: 'message' }>,
) {
  return JSON.stringify([
    entry.id,
    entry.role,
    entry.requestId ?? null,
  ]);
}

function joinEntries(entries: readonly AgentTimelineEntry[]) {
  return entries.map(formatTimelineEntry).join('\n');
}

function normalizeText(value: string) {
  return value.trim().replace(/\r\n/g, '\n');
}
