import type {
  AgentOperationEntry,
  AgentSession,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';
import { sessionActorLabel } from '../session/sessionDisplay';
import { LOADING_CELL_WIDTH } from '../visuals/loadingCells';
import { buildMessageDisplayLines } from './messageDisplay';
import { buildOperationDisplayLines } from './operationDisplay';

const OPERATION_LINE_PREFIX_WIDTH = 4;
export type TimelineDisplayLine = {
  text: string;
  tone:
    | 'added'
    | 'assistant'
    | 'assistant-label'
    | 'muted'
    | 'removed'
    | 'subagent'
    | 'system'
    | 'user'
    | 'user-label'
    | `operation-${AgentOperationEntry['phase']}`;
};

export function isSettledTimelineEntry(entry: AgentTimelineEntry) {
  if (entry.type === 'message') {
    return entry.status === 'completed';
  }
  return entry.phase === 'completed'
    || entry.phase === 'failed'
    || entry.phase === 'interrupted';
}

export function countSettledTimelinePrefix(
  timeline: readonly AgentTimelineEntry[],
  startIndex = 0,
) {
  let index = startIndex;
  while (index < timeline.length && isSettledTimelineEntry(timeline[index]!)) {
    index += 1;
  }
  return index;
}

export function formatTimelineEntry(
  entry: AgentTimelineEntry,
  options: {
    now?: number;
    width?: number;
  } = {},
) {
  return buildTimelineDisplayLines(entry, options)
    .map((line) => line.text)
    .join('\n');
}

export function buildTimelineDisplayLines(
  entry: AgentTimelineEntry,
  options: {
    now?: number;
    width?: number;
  } = {},
): TimelineDisplayLine[] {
  if (entry.type === 'operation') {
    const now = options.now
      ?? entry.completedAt
      ?? entry.updatedAt
      ?? entry.startedAt
      ?? 0;
    const width = options.width ?? Number.POSITIVE_INFINITY;
    return buildOperationDisplayLines(
      entry,
      now,
      width,
      Math.max(1, width - OPERATION_LINE_PREFIX_WIDTH),
    ).map((line, index) => (
      index === 0
        ? {
            text: `  ${operationMark(entry.phase)} ${line.text}`,
            tone: `operation-${entry.phase}` as const,
          }
        : {
            text: line.text,
            tone: line.tone === 'added' || line.tone === 'removed'
              ? line.tone
              : 'muted',
          }
    ));
  }
  return buildMessageDisplayLines(entry);
}

export function formatLiveSession(
  session: AgentSession,
  maxCodePoints = 80,
) {
  const pending = findLastPendingEntry(session.timeline);
  if (pending) {
    if (pending.type === 'message') {
      return formatLiveMessageTail(
        pending,
        maxCodePoints,
        sessionActorLabel(session),
      );
    }
    return singleLine(formatTimelineEntry(pending));
  }
  const run = session.activeRun;
  if (!run) return 'idle';
  if (run.state === 'pending_interrupt') return 'waiting for review';
  if (run.state === 'interrupting') return 'interrupting';
  if (run.activity === 'using_tool') return 'using tool';
  if (run.activity === 'streaming') return 'streaming response';
  return 'thinking';
}

export function formatLiveActivity(
  session: AgentSession,
  _frame = 0,
  maxCodePoints = 80,
  longWaiting = false,
  now = Date.now(),
) {
  const run = session.activeRun;
  if (!run) return formatLiveSession(session, maxCodePoints);
  const elapsed = formatElapsed(run.startedAt, now);
  const suffix = elapsed ? ` · ${elapsed}` : '';
  const activityWidth = Math.max(
    1,
    Math.floor(maxCodePoints) - [...suffix].length,
  );
  if (run.state === 'pending_interrupt') {
    return appendElapsed('! waiting for review', suffix, activityWidth);
  }
  if (run.state === 'interrupting') {
    return appendElapsed('◌ stopping response', suffix, activityWidth);
  }

  const loadingTextWidth = Math.max(
    1,
    activityWidth - LOADING_CELL_WIDTH - 1,
  );
  const detail = formatLiveSession(
    session,
    loadingTextWidth,
  );
  const actor = sessionActorLabel(session);
  let activity: string;
  switch (detail) {
    case 'thinking':
      activity = `${actor} is ${longWaiting ? 'still ' : ''}thinking`;
      break;
    case 'using tool':
      activity = `${actor} is ${longWaiting ? 'still ' : ''}using a tool`;
      break;
    case 'streaming response':
      activity = `${actor} is ${longWaiting ? 'still ' : ''}responding`;
      break;
    default:
      activity = detail;
  }
  return appendElapsed(activity, suffix, loadingTextWidth);
}

export function isLiveActivityPulseActive(
  session: AgentSession,
  _frame: number,
) {
  return session.activeRun?.state === 'running';
}

function formatLiveMessageTail(
  message: Extract<AgentTimelineEntry, { type: 'message' }>,
  maxCodePoints: number,
  actorLabel: string,
) {
  const label = `${
    message.role === 'assistant'
      ? actorLabel
      : message.role
  }  `;
  const text = singleLine(message.text);
  const budget = Math.max(1, Math.floor(maxCodePoints) - [...label].length);
  const characters = [...text];
  if (characters.length <= budget) {
    return `${label}${text}`;
  }
  const tailLength = Math.max(0, budget - 1);
  return `${label}…${tailLength ? characters.slice(-tailLength).join('') : ''}`;
}

export function operationMark(phase: AgentOperationEntry['phase']) {
  switch (phase) {
    case 'started':
    case 'updated':
      return '◌';
    case 'completed':
      return '●';
    case 'failed':
      return '×';
    case 'interrupted':
      return '■';
  }
}

function singleLine(text: string) {
  return text.replace(/\s*\n\s*/g, ' ↵ ');
}

function formatElapsed(startedAt: number | undefined, now: number) {
  if (
    typeof startedAt !== 'number'
    || !Number.isFinite(startedAt)
    || !Number.isFinite(now)
  ) return null;
  const elapsedMs = Math.max(0, now - startedAt);
  if (elapsedMs > 24 * 60 * 60 * 1_000) return null;
  const totalSeconds = Math.floor(elapsedMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function appendElapsed(activity: string, suffix: string, activityWidth: number) {
  const characters = [...activity];
  if (characters.length <= activityWidth) return `${activity}${suffix}`;
  if (activityWidth === 1) return `…${suffix}`;
  return `${characters.slice(0, activityWidth - 1).join('')}…${suffix}`;
}

function findLastPendingEntry(timeline: readonly AgentTimelineEntry[]) {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry && !isSettledTimelineEntry(entry)) return entry;
  }
  return undefined;
}
