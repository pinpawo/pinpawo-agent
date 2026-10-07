import {
  bg,
  bold,
  BoxRenderable,
  dim,
  fg,
  parseColor,
  StyledText,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type RenderContext,
  type ScrollbackSurface,
  type TextChunk,
} from '@opentui/core';
import type {
  AgentMessageEntry,
  AgentSession,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';
import {
  WELCOME_LOGO_HEIGHT,
  WELCOME_LOGO_WIDTH,
  WELCOME_PAD_COLUMNS,
  WELCOME_PAD_ROWS,
} from '../welcome/welcomeModel';
import { welcomeColors, type WelcomeColors } from '../welcome/welcomeTheme';
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
import { hasOpenToolCalls, isToolCallMessageEntry, toolCallTitle } from './messageDisplay';

const USER_MESSAGE_BACKGROUND = '#272c33';
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
    const colors = welcomeColors(this.renderer.themeMode);
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
          content: styleWelcomeLine(line || ' ', index, colors),
          fg: colors.foreground,
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

  render(source: AgentSession) {
    const session = { ...source, timeline: withToolCallOutcomes(source.timeline) };
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

/** Every unpainted welcome cell inherits the theme's welcome background. */
function styleWelcomeLine(line: string, row: number, colors: WelcomeColors) {
  return new StyledText(
    styleWelcomeContent(line, row, colors).map((chunk) =>
      chunk.bg ? chunk : { ...chunk, bg: parseColor(colors.background) },
    ),
  );
}

function styleWelcomeContent(line: string, row: number, colors: WelcomeColors) {
  const chunks: TextChunk[] = [];
  let remainder = line;
  const logoEnd = WELCOME_PAD_COLUMNS + WELCOME_LOGO_WIDTH;
  if (row >= WELCOME_PAD_ROWS && row < WELCOME_PAD_ROWS + WELCOME_LOGO_HEIGHT) {
    const logo = line.slice(0, logoEnd);
    if (/^[ █▀▄]+$/.test(logo)) {
      chunks.push(...styleWelcomeLogo(logo, colors));
      remainder = line.slice(logoEnd);
    }
  }
  chunks.push(...styleWelcomeText(remainder, colors));
  return chunks;
}

/** Full cells use backgrounds; half blocks retain the SVG's half-unit edges. */
function styleWelcomeLogo(logo: string, colors: WelcomeColors): TextChunk[] {
  return logo
    .split(/(█+|[▀▄]+)/)
    .filter(Boolean)
    .map((value) => value[0] === '█'
      ? bg(colors.foreground)(' '.repeat(value.length))
      : fg(colors.foreground)(value));
}

function styleWelcomeText(text: string, colors: WelcomeColors): TextChunk[] {
  if (!text) return [];
  const leading = text.match(/^\s*/)?.[0] ?? '';
  const value = text.slice(leading.length);
  const chunks: TextChunk[] = leading ? [fg(colors.foreground)(leading)] : [];

  if (value.startsWith('PinPawo TUI v2')) {
    chunks.push(bold(fg(colors.foreground)(value)));
    return chunks;
  }
  if (/^v\S+\s+·\s+host\b/.test(value)) {
    chunks.push(dim(fg(colors.muted)(value)));
    return chunks;
  }
  if (/^(?:connected|connecting|reconnecting|disconnected)\b/.test(value)) {
    chunks.push(fg(colors.status)(value));
    return chunks;
  }
  const detail = value.match(/^(model|directory|capabilities)(\s+)(.*)$/);
  if (detail) {
    chunks.push(
      dim(fg(colors.muted)(detail[1]!)),
      fg(colors.muted)(detail[2]!),
      fg(colors.foreground)(detail[3]!),
    );
    return chunks;
  }
  if (value.startsWith('/ commands') || value.startsWith('Ctrl+')) {
    chunks.push(dim(fg(colors.muted)(value)));
    return chunks;
  }
  chunks.push(fg(colors.foreground)(value));
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

const displayTimelines = new WeakMap<readonly AgentTimelineEntry[], readonly AgentTimelineEntry[]>();

/**
 * The timeline as the transcript writes it. A call's line is committed while
 * it runs, so a call that then fails or is interrupted cannot change that line:
 * its outcome becomes a row of its own where the call's work ends, and the
 * call's own line keeps its title alone.
 */
export function withToolCallOutcomes(timeline: readonly AgentTimelineEntry[]): readonly AgentTimelineEntry[] {
  const cached = displayTimelines.get(timeline);
  if (cached) return cached;
  const outcomes = new Map<number, AgentMessageEntry[]>();
  const display = timeline.map((entry, index) => {
    if (!isToolCallMessageEntry(entry)) return entry;
    const unsuccessful = entry.toolCalls!.filter(call => call.status === 'failed' || call.status === 'interrupted');
    if (!unsuccessful.length) return entry;
    let end = index + 1;
    while (end < timeline.length && isToolCallContent(timeline[end]!)) end += 1;
    outcomes.set(end, [...outcomes.get(end) ?? [], {
      type: 'message', id: `${entry.id}:outcome`, role: 'assistant', text: '', toolCalls: unsuccessful, status: 'completed',
    }]);
    return { ...entry, toolCalls: entry.toolCalls!.map(call => unsuccessful.includes(call) ? { ...call, status: 'completed' as const } : call) };
  });
  const result = outcomes.size
    ? [...display.keys(), display.length].flatMap(index => [...outcomes.get(index) ?? [], ...display.slice(index, index + 1)])
    : timeline;
  displayTimelines.set(timeline, result);
  return result;
}

/** What follows a message as the work its calls started. */
function isToolCallContent(entry: AgentTimelineEntry) {
  return isDelegationScopeChild(entry) || (entry.type === 'message' && entry.role === 'subagent');
}

export function timelineFingerprint(entry: AgentTimelineEntry) {
  if (entry.type === 'message') {
    return JSON.stringify([
      'message',
      entry.role,
      normalizeText(entry.text),
      entry.status,
      // A committed call line holds its title alone; only an outcome row,
      // written once the call has ended, carries the outcome.
      ...(entry.toolCalls ?? []).map(call => normalizeText(toolCallTitle(call))
        + (call.status === 'failed' || call.status === 'interrupted' ? `:${call.status}` : '')),
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

  // A message's open tool calls own the operations that follow it until they
  // settle: those are their content, not its peers. The stream delivers them
  // contiguously behind the message, so tracking one open scope is enough to
  // nest them.
  let delegationScope: BoxRenderable | null = null;

  entries.forEach((entry, entryIndex) => {
    if (entry.type === 'message' && entry.role === 'subagent') return;
    const childCountBeforeEntry = root.getChildrenCount();
    const lines = buildTimelineDisplayLines(entry, {
      now,
      width,
    });
    if (delegationScope && !isDelegationScopeChild(entry)) {
      delegationScope = null;
    }
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
      && entry.role === 'assistant'
      && entry.text.trim()
      && assistantMarkdownStyle
    ) {
      const detailSurface = root;
      const label = entry.updatedAt ?? entry.createdAt ? lines[0] : undefined;
      if (label) addLine(label, detailSurface);
      assistantMarkdown = createAssistantMarkdownSurface(context, {
        id: `${root.id}:${entry.role}:${entryIndex}:${entry.id}`,
        content: entry.text,
        syntaxStyle: assistantMarkdownStyle,
      });
      detailSurface.add(assistantMarkdown.container);
      if (isToolCallMessageEntry(entry)) {
        lines.slice(-entry.toolCalls!.length).forEach(line => addLine(line, detailSurface));
        openToolCallScope(entry);
      }
      if (root.getChildrenCount() > childCountBeforeEntry) {
        addTimelineEntrySpacing(entry);
      }
      return;
    }
    const scopeParent = entry.type === 'operation' ? delegationScope ?? root : root;
    const detailSurface = lines.length > 0 && isDetailEntry(entry)
      ? createDetailEntrySurface(context, scopeParent, entryIndex, entry.id)
      : scopeParent;
    lines.forEach((line, lineIndex) => {
      addLine(
        entry.type === 'operation' && lineIndex === 0
          ? { ...line, text: line.text.replace(/^ {2}/, '') }
          : line,
        detailSurface,
      );
    });
    if (isToolCallMessageEntry(entry)) openToolCallScope(entry);
    if (root.getChildrenCount() > childCountBeforeEntry) {
      addTimelineEntrySpacing(entry);
    }
  });
  return { assistantMarkdown };

  function openToolCallScope(entry: AgentMessageEntry) {
    // Leave the scope open only while a call still runs; settled calls have
    // no more content coming.
    delegationScope = hasOpenToolCalls(entry)
      ? createDelegationScopeSurface(context, root, entries.indexOf(entry), entry.id)
      : null;
  }

  function addTimelineEntrySpacing(entry: AgentTimelineEntry) {
    if (!isSettledTimelineEntry(entry)) return;
    if (entry.type === 'operation') return;
    addLine({ text: ' ', tone: 'muted' });
  }
}

/**
 * Indented container holding a running delegation's tool calls. Mirrors the
 * detail-entry indent so nested operations line up with other detail rows.
 */
function createDelegationScopeSurface(
  context: RenderContext,
  root: BoxRenderable,
  entryIndex: number,
  entryId: string,
) {
  const surface = new BoxRenderable(context, {
    id: `${root.id}:delegation:${entryIndex}:${entryId}`,
    width: '100%',
    height: 'auto',
    flexDirection: 'column',
    paddingLeft: DETAIL_ENTRY_INDENT,
  });
  root.add(surface);
  return surface;
}

/** Operations render as open tool calls' content; messages end their scope. */
function isDelegationScopeChild(entry: AgentTimelineEntry) {
  return entry.type === 'operation';
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
    // Timestamps are wayfinding, not content: dim keeps them legible without
    // competing with the message they head.
    case 'user-label':
      return {
        attributes: TextAttributes.DIM,
        fg: USER_MESSAGE_LABEL_COLOR,
        bg: USER_MESSAGE_BACKGROUND,
      };
    case 'assistant-label':
      return {
        attributes: TextAttributes.DIM,
        fg: ASSISTANT_LABEL_COLOR,
      };
    case 'user':
      return {
        fg: USER_MESSAGE_TEXT_COLOR,
        bg: USER_MESSAGE_BACKGROUND,
      };
    case 'added':
      return { fg: '#7fcf9b' };
    case 'operation-completed':
      return { fg: '#a8b6c5' };
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
      return { fg: '#8f9ba8' };
    case 'operation-started':
    case 'operation-updated':
      return { fg: '#69c0c8' };
    case 'assistant':
      return {};
  }
}

function normalizeText(value: string) {
  return value.trim().replace(/\r\n/g, '\n');
}
