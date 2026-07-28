import {
  BoxRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type RenderContext,
  type ScrollbackSurface,
} from '@opentui/core';
import type {
  AgentSession,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';
import {
  countSettledTimelinePrefix,
  buildTimelineDisplayLines,
  isSettledTimelineEntry,
  type TimelineDisplayLine,
} from './timelineModel';
import {
  createAssistantMarkdownStyle,
  createAssistantMarkdownSurface,
  stableAssistantMarkdownRows,
  type AssistantMarkdownSurface,
} from './assistantMarkdown';

type ActiveTimelineSurface = {
  surface: ScrollbackSurface;
  root: BoxRenderable;
  entryKey: string;
  mode: 'streaming-message' | 'ordered-tail';
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
  private activeTimelineSurface: ActiveTimelineSurface | null = null;
  private readonly assistantMarkdownStyle = createAssistantMarkdownStyle();
  private assistantMarkdownStyleDestroyed = false;

  constructor(private readonly renderer: CliRenderer) {}

  renderWelcome(lines: readonly string[]) {
    if (this.welcomeRendered || lines.length === 0) return;
    this.renderer.writeToScrollback((context) => {
      const root = new BoxRenderable(context.renderContext, {
        id: 'pinpawo-welcome',
        width: context.width,
        height: lines.length,
        flexDirection: 'column',
      });
      lines.forEach((line, index) => {
        root.add(new TextRenderable(context.renderContext, {
          id: `pinpawo-welcome:${index}`,
          width: '100%',
          height: 1,
          content: line || ' ',
          fg: '#69c0c8',
        }));
      });
      return {
        root,
        width: context.width,
        height: lines.length,
      };
    });
    this.welcomeRendered = true;
  }

  render(session: AgentSession) {
    if (session.sessionId !== this.sessionId) {
      const previousSessionId = this.sessionId;
      this.destroyTimelineSurface();
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
    if (this.activeTimelineSurface) {
      const active = this.activeTimelineSurface;
      if (active.mode === 'streaming-message') {
        if (
          firstEntry?.type === 'message'
          && liveEntryKey(firstEntry) === active.entryKey
        ) {
          if (isSettledTimelineEntry(firstEntry)) {
            this.renderLiveEntries(
              [firstEntry],
              true,
              active.mode,
              session.actor?.label,
            );
            this.committedFingerprints.push(timelineFingerprint(firstEntry));
            this.destroyTimelineSurface();
            firstUncommitted += 1;
          }
        } else {
          this.destroyTimelineSurface();
        }
      } else if (
        !firstEntry
        || liveEntryKey(firstEntry) !== active.entryKey
        || isSettledTimelineEntry(firstEntry)
      ) {
        // Ordered tails never commit partial rows. Once their first operation
        // settles, replace the transient surface with the canonical settled
        // prefix below.
        this.destroyTimelineSurface();
      }
    }

    for (const [start, end] of planSettledTimelineCommits(
      firstUncommitted,
      settledEnd,
    )) {
      this.commitSettledEntries(
        session.timeline.slice(start, end),
        session.actor?.label,
      );
    }
    this.reconciliationCache = timelineReconciliationCache(
      session.timeline,
      settledEnd,
    );

    const pendingEntry = session.timeline[settledEnd];
    if (pendingEntry && !isSettledTimelineEntry(pendingEntry)) {
      const mode = pendingEntry.type === 'message'
        ? 'streaming-message'
        : 'ordered-tail';
      const liveEntries = mode === 'streaming-message'
        ? [pendingEntry]
        : session.timeline.slice(settledEnd);
      this.renderLiveEntries(
        liveEntries,
        false,
        mode,
        session.actor?.label,
      );
    } else if (this.activeTimelineSurface) {
      this.destroyTimelineSurface();
    }
  }

  destroy() {
    this.destroyTimelineSurface();
    if (!this.assistantMarkdownStyleDestroyed) {
      this.assistantMarkdownStyle.destroy();
      this.assistantMarkdownStyleDestroyed = true;
    }
  }

  private destroyTimelineSurface() {
    if (
      this.activeTimelineSurface
      && !this.activeTimelineSurface.surface.isDestroyed
    ) {
      this.activeTimelineSurface.surface.destroy();
    }
    this.activeTimelineSurface = null;
  }

  private commitSettledEntries(
    entries: readonly AgentTimelineEntry[],
    actorLabel?: string,
  ) {
    if (entries.length === 0) return;
    const surface = this.renderer.createScrollbackSurface({ startOnNewLine: true });
    const root = createTimelineRoot(surface.renderContext, {
      id: 'timeline-settled',
      entries,
      width: this.renderer.width,
      actorLabel,
      assistantMarkdownStyle: this.assistantMarkdownStyle,
    });
    try {
      surface.root.add(root);
      if (root.getChildrenCount() === 0) {
        this.committedFingerprints.push(...entries.map(timelineFingerprint));
        return;
      }
      surface.render();

      const settledRows = root.height;
      if (typeof settledRows !== 'number' || settledRows < 0) {
        throw new Error('OpenTUI did not measure settled timeline rows');
      }
      if (settledRows === 0) {
        this.committedFingerprints.push(...entries.map(timelineFingerprint));
        return;
      }
      surface.commitRows(0, settledRows);
      this.committedFingerprints.push(...entries.map(timelineFingerprint));
    } finally {
      surface.destroy();
    }
  }

  private renderLiveEntries(
    entries: readonly AgentTimelineEntry[],
    completed: boolean,
    mode: ActiveTimelineSurface['mode'],
    actorLabel?: string,
  ) {
    const entry = entries[0];
    if (!entry) return;
    const entryKey = liveEntryKey(entry);
    let active = this.activeTimelineSurface;
    if (
      !active
      || active.entryKey !== entryKey
      || active.mode !== mode
      || active.surface.isDestroyed
    ) {
      this.destroyTimelineSurface();
      const surface = this.renderer.createScrollbackSurface({ startOnNewLine: true });
      const root = createTimelineRoot(surface.renderContext, {
        id: `timeline-live-${entry.id}`,
        entries: [],
        width: this.renderer.width,
        actorLabel,
        assistantMarkdownStyle: this.assistantMarkdownStyle,
      });
      surface.root.add(root);
      active = {
        surface,
        root,
        entryKey,
        mode,
        committedRows: 0,
      };
      this.activeTimelineSurface = active;
    }

    try {
      const populated = populateTimelineRoot(
        active.surface.renderContext,
        active.root,
        entries,
        this.renderer.width,
        actorLabel,
        this.assistantMarkdownStyle,
      );
      active.surface.render();
      const stableRows = completed
        ? active.surface.height
        : stableRowsForLiveMode(
            mode,
            active.surface.height,
            populated.assistantMarkdown,
          );
      if (stableRows > active.committedRows) {
        active.surface.commitRows(active.committedRows, stableRows);
        active.committedRows = stableRows;
      }
    } catch (error) {
      this.destroyTimelineSurface();
      throw error;
    }
  }

  private writeSessionSeparator(sessionId: string) {
    this.renderer.writeToScrollback((context) => {
      const lines = [' ', `── session ${sessionId} ──`];
      const root = new BoxRenderable(context.renderContext, {
        id: `session-${sessionId}`,
        width: context.width,
        height: 2,
        flexDirection: 'column',
      });
      lines.forEach((line, index) => {
        root.add(new TextRenderable(context.renderContext, {
          id: `session-${sessionId}:${index}`,
          width: '100%',
          height: 1,
          content: line,
          fg: '#8a8a8a',
        }));
      });
      return {
        root,
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

function liveEntryKey(entry: AgentTimelineEntry) {
  return entry.type === 'message'
    ? JSON.stringify([
        entry.type,
        entry.id,
        entry.role,
        entry.requestId ?? null,
      ])
    : JSON.stringify([
        entry.type,
        entry.id,
        entry.requestId,
        entry.operationKey,
      ]);
}

function stableRowsForLiveMode(
  mode: ActiveTimelineSurface['mode'],
  height: number,
  assistantMarkdown: AssistantMarkdownSurface | null,
) {
  if (mode === 'ordered-tail') {
    // Operation headers and output can both change until the terminal phase.
    // Later canonical entries may already exist behind the operation, so keep
    // the complete ordered tail transient and commit it only after the
    // operation settles.
    return 0;
  }
  if (assistantMarkdown) {
    return Math.min(
      height,
      stableAssistantMarkdownRows(assistantMarkdown),
    );
  }
  return Math.max(0, height - 1);
}

function createTimelineRoot(
  context: RenderContext,
  options: {
    id: string;
    entries: readonly AgentTimelineEntry[];
    width: number;
    actorLabel?: string;
    assistantMarkdownStyle: ReturnType<typeof createAssistantMarkdownStyle>;
  },
) {
  const root = new BoxRenderable(context, {
    id: options.id,
    width: '100%',
    height: 'auto',
    flexDirection: 'column',
  });
  populateTimelineRoot(
    context,
    root,
    options.entries,
    options.width,
    options.actorLabel,
    options.assistantMarkdownStyle,
  );
  return root;
}

function populateTimelineRoot(
  context: RenderContext,
  root: BoxRenderable,
  entries: readonly AgentTimelineEntry[],
  width: number,
  actorLabel?: string,
  assistantMarkdownStyle?: ReturnType<typeof createAssistantMarkdownStyle>,
) {
  for (const child of root.getChildren()) {
    root.remove(child);
    child.destroyRecursively();
  }

  const now = Date.now();
  let lineIndex = 0;
  let assistantMarkdown: AssistantMarkdownSurface | null = null;
  const addLine = (line: TimelineDisplayLine) => {
    root.add(new TextRenderable(context, {
      id: `${root.id}:line:${lineIndex++}`,
      width: '100%',
      height: 'auto',
      content: line.text || ' ',
      ...lineStyle(line),
    }));
  };

  entries.forEach((entry, entryIndex) => {
    const lines = buildTimelineDisplayLines(entry, {
      actorLabel,
      now,
      width,
    });
    if (
      entry.type === 'message'
      && entry.role === 'assistant'
      && assistantMarkdownStyle
    ) {
      const label = lines[0];
      if (label) addLine(label);
      assistantMarkdown = createAssistantMarkdownSurface(context, {
        id: `${root.id}:assistant:${entryIndex}:${entry.id}`,
        content: entry.text,
        syntaxStyle: assistantMarkdownStyle,
      });
      root.add(assistantMarkdown.container);
      return;
    }
    lines.forEach(addLine);
  });
  return { assistantMarkdown };
}

function lineStyle(line: TimelineDisplayLine): {
  attributes?: number;
  fg?: string;
} {
  switch (line.tone) {
    case 'user-label':
    case 'assistant-label':
      return {
        attributes: TextAttributes.BOLD,
        fg: '#5fd75f',
      };
    case 'user':
    case 'added':
    case 'operation-completed':
      return { fg: '#5fd75f' };
    case 'system':
    case 'subagent':
    case 'operation-interrupted':
      return {
        attributes: TextAttributes.DIM,
        fg: '#d7af5f',
      };
    case 'removed':
    case 'operation-failed':
      return { fg: '#ff5f5f' };
    case 'muted':
    case 'operation-started':
    case 'operation-updated':
      return { attributes: TextAttributes.DIM };
    case 'assistant':
      return {};
  }
}

function normalizeText(value: string) {
  return value.trim().replace(/\r\n/g, '\n');
}
