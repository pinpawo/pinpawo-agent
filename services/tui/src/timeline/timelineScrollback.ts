import {
  bg,
  bold,
  BoxRenderable,
  dim,
  fg,
  StyledText,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type RenderContext,
  type ScrollbackSurface,
  type TextChunk,
} from '@opentui/core';
import type {
  AgentSession,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';
import {
  WELCOME_LOGO_HEIGHT,
  WELCOME_LOGO_WIDTH,
} from '../welcome/welcomeModel';
import {
  countSettledTimelinePrefix,
  buildTimelineDisplayLines,
  isSettledTimelineEntry,
  type TimelineDisplayLine,
} from './timelineModel';
import {
  createAssistantMarkdownStyle,
  createAssistantMarkdownSurface,
  type AssistantMarkdownSurface,
} from './assistantMarkdown';
import { subagentDisplayText } from './messageDisplay';

const WELCOME_COLOR = '#69c0c8';
const WELCOME_MUTED_COLOR = '#789da3';
const WELCOME_STATUS_COLOR = '#7fcf9b';
const WELCOME_TITLE_COLOR = '#efa6ca';
const USER_MESSAGE_BACKGROUND = '#303842';
const USER_MESSAGE_LABEL_COLOR = '#9fcbd2';
const USER_MESSAGE_TEXT_COLOR = '#e7ecee';
const ASSISTANT_LABEL_COLOR = '#69c0c8';
const DETAIL_ENTRY_INDENT = 2;

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
          content: styleWelcomeLine(line || ' ', index),
          fg: WELCOME_COLOR,
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

  /**
   * Discard terminal-local scrollback and replay the next canonical session
   * snapshot. This is intentionally explicit: committed terminal rows cannot
   * otherwise be removed when a snapshot corrects provisional live output.
   */
  resetForReplay() {
    this.destroyTimelineSurface();
    this.renderer.resetSplitFooterForReplay({ clearSavedLines: true });
    this.welcomeRendered = false;
    this.sessionId = null;
    this.committedFingerprints = [];
    this.reconciliationCache = {
      prefixLength: 0,
      tailEntry: null,
    };
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
  ) {
    if (entries.length === 0) return;
    const surface = this.renderer.createScrollbackSurface({ startOnNewLine: true });
    const root = createTimelineRoot(surface.renderContext, {
      id: 'timeline-settled',
      entries,
      width: this.renderer.width,
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

function styleWelcomeLine(line: string, row: number) {
  if (line.startsWith('╭') || line.startsWith('╰')) {
    return new StyledText([dim(fg(WELCOME_MUTED_COLOR)(line))]);
  }
  if (line.startsWith('│ ') && line.endsWith(' │')) {
    return new StyledText([
      dim(fg(WELCOME_MUTED_COLOR)('│ ')),
      ...styleWelcomeContent(line.slice(2, -2), row - 1),
      dim(fg(WELCOME_MUTED_COLOR)(' │')),
    ]);
  }
  return new StyledText(styleWelcomeContent(line, row));
}

function styleWelcomeContent(line: string, row: number) {
  const chunks: TextChunk[] = [];
  let remainder = line;
  if (row < WELCOME_LOGO_HEIGHT) {
    const logo = line.slice(0, WELCOME_LOGO_WIDTH);
    chunks.push(...logo
      .split(/(█+)/)
      .filter(Boolean)
      .map((value) => value[0] === '█'
        ? bg(WELCOME_COLOR)(' '.repeat(value.length))
        : fg(WELCOME_COLOR)(value)));
    remainder = line.slice(WELCOME_LOGO_WIDTH);
  }
  chunks.push(...styleWelcomeText(remainder));
  return chunks;
}

function styleWelcomeText(text: string): TextChunk[] {
  if (!text) return [];
  const leading = text.match(/^\s*/)?.[0] ?? '';
  const value = text.slice(leading.length);
  const chunks: TextChunk[] = leading ? [fg(WELCOME_COLOR)(leading)] : [];

  if (value.startsWith('PinPawo TUI v2')) {
    chunks.push(bold(fg(WELCOME_TITLE_COLOR)(value)));
    return chunks;
  }
  if (/^v\S+\s+·\s+local-agent\b/.test(value)) {
    chunks.push(dim(fg(WELCOME_MUTED_COLOR)(value)));
    return chunks;
  }
  if (/^(?:connected|connecting|reconnecting|disconnected)\b/.test(value)) {
    chunks.push(fg(WELCOME_STATUS_COLOR)(value));
    return chunks;
  }
  const detail = value.match(/^(model|directory|capabilities)(\s+)(.*)$/);
  if (detail) {
    chunks.push(
      dim(fg(WELCOME_MUTED_COLOR)(detail[1]!)),
      fg(WELCOME_MUTED_COLOR)(detail[2]!),
      fg(WELCOME_COLOR)(detail[3]!),
    );
    return chunks;
  }
  if (value.startsWith('/ commands') || value.startsWith('Ctrl+')) {
    chunks.push(dim(fg(WELCOME_MUTED_COLOR)(value)));
    return chunks;
  }
  chunks.push(fg(WELCOME_COLOR)(value));
  return chunks;
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
    // A live assistant message may be superseded by a later model lifecycle
    // before the run's checkpoint is written. Keep it entirely mutable until
    // the canonical snapshot confirms it, rather than committing rows the
    // terminal cannot retract.
    return 0;
  }
  return 0;
}

function createTimelineRoot(
  context: RenderContext,
  options: {
    id: string;
    entries: readonly AgentTimelineEntry[];
    width: number;
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
    options.assistantMarkdownStyle,
  );
  return root;
}

function populateTimelineRoot(
  context: RenderContext,
  root: BoxRenderable,
  entries: readonly AgentTimelineEntry[],
  width: number,
  assistantMarkdownStyle?: ReturnType<typeof createAssistantMarkdownStyle>,
) {
  for (const child of root.getChildren()) {
    root.remove(child);
    child.destroyRecursively();
  }

  const now = Date.now();
  let lineIndex = 0;
  let assistantMarkdown: AssistantMarkdownSurface | null = null;
  const addLine = (
    line: TimelineDisplayLine,
    parent: BoxRenderable = root,
  ) => {
    parent.add(new TextRenderable(context, {
      id: `${root.id}:line:${lineIndex++}`,
      width: '100%',
      height: 'auto',
      content: line.text || ' ',
      ...lineStyle(line),
    }));
  };

  entries.forEach((entry, entryIndex) => {
    const childCountBeforeEntry = root.getChildrenCount();
    const lines = buildTimelineDisplayLines(entry, {
      now,
      width,
    });
    if (entry.type === 'message' && entry.role === 'user') {
      const userMessageSurface = new BoxRenderable(context, {
        id: `${root.id}:user:${entryIndex}:${entry.id}`,
        width: '100%',
        height: 'auto',
        flexDirection: 'column',
        paddingTop: 1,
        paddingBottom: 1,
        backgroundColor: USER_MESSAGE_BACKGROUND,
      });
      root.add(userMessageSurface);
      lines.forEach((line) => addLine(line, userMessageSurface));
      addTimelineEntrySpacing(entry);
      return;
    }
    if (
      entry.type === 'message'
      && (entry.role === 'assistant' || entry.role === 'subagent')
      && entry.text.trim()
      && assistantMarkdownStyle
    ) {
      const detailSurface = entry.role === 'subagent'
        ? createDetailEntrySurface(context, root, entryIndex, entry.id)
        : root;
      const label = entry.updatedAt ?? entry.createdAt ? lines[0] : undefined;
      if (label) addLine(label, detailSurface);
      assistantMarkdown = createAssistantMarkdownSurface(context, {
        id: `${root.id}:${entry.role}:${entryIndex}:${entry.id}`,
        content: entry.role === 'subagent'
          ? subagentDisplayText(entry.text)
          : entry.text,
        syntaxStyle: assistantMarkdownStyle,
      });
      detailSurface.add(assistantMarkdown.container);
      if (root.getChildrenCount() > childCountBeforeEntry) {
        addTimelineEntrySpacing(entry);
      }
      return;
    }
    const detailSurface = lines.length > 0 && isDetailEntry(entry)
      ? createDetailEntrySurface(context, root, entryIndex, entry.id)
      : root;
    lines.forEach((line, lineIndex) => {
      addLine(
        entry.type === 'operation' && lineIndex === 0
          ? { ...line, text: line.text.replace(/^ {2}/, '') }
          : line,
        detailSurface,
      );
    });
    if (root.getChildrenCount() > childCountBeforeEntry) {
      addTimelineEntrySpacing(entry);
    }
  });
  return { assistantMarkdown };

  function addTimelineEntrySpacing(entry: AgentTimelineEntry) {
    if (!isSettledTimelineEntry(entry)) return;
    addLine({ text: ' ', tone: 'muted' });
  }
}

function createDetailEntrySurface(
  context: RenderContext,
  root: BoxRenderable,
  entryIndex: number,
  entryId: string,
) {
  const surface = new BoxRenderable(context, {
    id: `${root.id}:detail:${entryIndex}:${entryId}`,
    width: '100%',
    height: 'auto',
    flexDirection: 'column',
    paddingLeft: DETAIL_ENTRY_INDENT,
  });
  root.add(surface);
  return surface;
}

function isDetailEntry(entry: AgentTimelineEntry) {
  return entry.type === 'operation'
    || (
      entry.type === 'message'
      && (entry.role === 'subagent' || entry.role === 'system')
    );
}

function lineStyle(line: TimelineDisplayLine): {
  attributes?: number;
  fg?: string;
  bg?: string;
} {
  switch (line.tone) {
    case 'user-label':
      return {
        attributes: TextAttributes.BOLD,
        fg: USER_MESSAGE_LABEL_COLOR,
        bg: USER_MESSAGE_BACKGROUND,
      };
    case 'assistant-label':
      return {
        attributes: TextAttributes.BOLD,
        fg: ASSISTANT_LABEL_COLOR,
      };
    case 'user':
      return {
        fg: USER_MESSAGE_TEXT_COLOR,
        bg: USER_MESSAGE_BACKGROUND,
      };
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
