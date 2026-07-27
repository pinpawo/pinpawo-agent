import type {
  AgentOperationEntry,
  AgentSession,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';

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

export function formatTimelineEntry(entry: AgentTimelineEntry) {
  if (entry.type === 'operation') {
    const target = entry.target ? ` ${entry.target}` : '';
    const summary = entry.summary ? ` — ${entry.summary}` : '';
    return `  ${operationMark(entry.phase)} ${entry.title}${target}${summary}`;
  }
  const label = `${entry.role}`.padEnd(10);
  return indentContinuationLines(`${label} ${entry.text}`, label.length + 1);
}

export function formatLiveSession(session: AgentSession) {
  const pending = findLastPendingEntry(session.timeline);
  if (pending) {
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

function indentContinuationLines(text: string, spaces: number) {
  const indentation = ' '.repeat(spaces);
  return text.replace(/\n/g, `\n${indentation}`);
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
