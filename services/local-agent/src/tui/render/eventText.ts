import type {
  AgentSystemNoticeEvent,
} from '@pinpawo/agent-session';
import { TUI_TEXT } from './text';
import { elapsedMsSince, formatElapsed } from './terminalText';
import type { ActiveOperation, PendingUiState } from '../types';

const SUBAGENT_TEXT_LINE_CHARS = 64;

export function formatSystemNoticeEvent(event: AgentSystemNoticeEvent): string | null {
  const notice = event.message.trim();
  return notice || null;
}

export function formatSubagentMessage(text: string): string | null {
  const content = formatSubagentTextBody(text);
  return content || null;
}

export function buildBusyStatusLine(
  pending: PendingUiState,
  now: number,
  spinnerFrame: string,
  activeOperations: ActiveOperation[],
) {
  const phase = buildBusyPhaseLabel(pending, now);
  const elapsed = formatElapsed(pending.startedAt, now);
  const segments = [
    phase,
    elapsed ?? TUI_TEXT.elapsedUnavailable,
    ...(pending.charCount > 0 ? [TUI_TEXT.modelOutputChars(pending.charCount)] : []),
    ...(activeOperations.length > 0 ? [activeOperations.map((operation) => operation.name).join(', ')] : []),
  ];
  return `${spinnerFrame} ${segments.join(' · ')}`;
}

function buildBusyPhaseLabel(pending: PendingUiState, now: number) {
  if (pending.phase === 'interrupting') return TUI_TEXT.busyPhaseInterrupting;
  if (pending.phase === 'replying') return TUI_TEXT.busyPhaseReplying;
  const elapsedMs = elapsedMsSince(pending.startedAt, now) ?? 0;
  if (elapsedMs < 3000) return TUI_TEXT.busyPhaseThinking;
  if (elapsedMs < 10000) return TUI_TEXT.busyPhaseUsingTools;
  return TUI_TEXT.busyPhaseLongRunning;
}

function formatSubagentTextBody(text: string) {
  const normalized = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return '';

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => splitLongParagraph(paragraph.trim()).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}

function splitLongParagraph(paragraph: string) {
  const sentences = paragraph.match(/[^。！？!?]+[。！？!?]?/g) ?? [paragraph];
  const lines: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const item = sentence.trim();
    if (!item) continue;
    if (current && current.length + item.length > SUBAGENT_TEXT_LINE_CHARS) {
      lines.push(current);
      current = item;
      continue;
    }
    current = current ? `${current}${item}` : item;
  }
  if (current) lines.push(current);
  return lines;
}
