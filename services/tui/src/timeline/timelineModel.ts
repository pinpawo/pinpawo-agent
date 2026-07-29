import type {
  AgentOperationEntry,
  AgentSession,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';
import { sessionActorLabel } from '../session/sessionDisplay';
import { buildMessageDisplayLines } from './messageDisplay';
import { buildOperationDisplayLines } from './operationDisplay';

const OPERATION_LINE_PREFIX_WIDTH = 4;
const LIVE_ACTIVITY_FRAMES = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
] as const;
export const LIVE_ACTIVITY_PULSE_FRAMES = LIVE_ACTIVITY_FRAMES.length;

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
    actorLabel?: string;
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
    actorLabel?: string;
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
  return buildMessageDisplayLines(
    entry,
    options.actorLabel,
  );
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
  if (run.state === 'waiting_review') return 'waiting for review';
  if (run.state === 'interrupting') return 'interrupting';
  if (run.activity === 'using_tool') return 'using tool';
  if (run.activity === 'streaming') return 'streaming response';
  return 'thinking';
}

export function formatLiveActivity(
  session: AgentSession,
  frame = 0,
  maxCodePoints = 80,
  longWaiting = false,
) {
  const run = session.activeRun;
  if (!run) return formatLiveSession(session, maxCodePoints);
  if (run.state === 'waiting_review') return '! waiting for review';
  if (run.state === 'interrupting') return '◌ stopping response';

  const normalizedFrame = Math.max(0, Math.floor(frame));
  const marker = LIVE_ACTIVITY_FRAMES[
    normalizedFrame % LIVE_ACTIVITY_FRAMES.length
  ];
  const detail = formatLiveSession(
    session,
    Math.max(1, Math.floor(maxCodePoints) - 2),
  );
  const actor = sessionActorLabel(session);
  switch (detail) {
    case 'thinking':
      return `${marker} ${actor} is ${longWaiting ? 'still ' : ''}thinking`;
    case 'using tool':
      return `${marker} ${actor} is ${longWaiting ? 'still ' : ''}using a tool`;
    case 'streaming response':
      return `${marker} ${actor} is ${longWaiting ? 'still ' : ''}responding`;
    default:
      return `${marker} ${detail}`;
  }
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

function findLastPendingEntry(timeline: readonly AgentTimelineEntry[]) {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry && !isSettledTimelineEntry(entry)) return entry;
  }
  return undefined;
}
