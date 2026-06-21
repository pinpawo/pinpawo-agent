import type { LocalAgentOperationEvent, LocalAgentOperationPhase } from '../../events/localAgentEvent';
import type { HistoryCellModel } from '../state/tuiState';
import {
  buildOperationPresentation,
  type OperationPresentation,
} from './operationPresentation';

export type AgentTimelineEntry =
  | AgentMessageEntry
  | AgentOperationEntry
  | AgentReviewEntry
  | AgentNoticeEntry
  | AgentErrorEntry
  | AgentStudioProgressEntry;

export type AgentTimelineMessage =
  | AgentUserTimelineMessage
  | AgentAssistantTimelineMessage
  | AgentToolTimelineMessage;

export type AgentUserTimelineMessage = {
  id: string;
  type: 'message';
  role: 'user';
  requestId?: string;
  text: string;
  status: 'completed';
  createdAt?: string;
  updatedAt?: string;
};

export type AgentAssistantTimelineMessage = {
  id: string;
  type: 'message';
  role: 'assistant';
  requestId?: string;
  text: string;
  status: 'completed' | 'streaming';
  createdAt?: string;
  updatedAt?: string;
};

export type AgentToolTimelineMessage = AgentOperationEntry;

export type AgentMessageEntry = {
  id: string;
  type: 'message';
  role: 'user' | 'assistant' | 'subagent';
  requestId?: string;
  text: string;
  status: 'completed' | 'streaming';
  createdAt?: string;
  updatedAt?: string;
};

export type AgentOperationEntry = OperationPresentation & {
  id: string;
  type: 'operation';
  requestId: string;
  phase: LocalAgentOperationPhase;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type AgentReviewEntry = {
  id: string;
  type: 'review';
  requestId: string;
  reviewId: string;
  status: 'waiting' | 'answered' | 'interrupted';
  createdAt?: string;
  updatedAt?: string;
};

export type AgentNoticeEntry = {
  id: string;
  type: 'notice';
  requestId?: string;
  text: string;
  createdAt?: string;
};

export type AgentErrorEntry = {
  id: string;
  type: 'error';
  requestId?: string;
  text: string;
  createdAt?: string;
};

export type AgentStudioProgressEntry = {
  id: string;
  type: 'studio.progress';
  requestId: string;
  text: string;
  createdAt?: string;
};

export function timelineEntryIdFromHistoryCell(cell: Pick<HistoryCellModel, 'id'>) {
  return `history:${cell.id}`;
}

export function isAgentTimelineMessage(entry: AgentTimelineEntry): entry is AgentTimelineMessage {
  if (entry.type === 'operation') return true;
  return entry.type === 'message'
    && (entry.role === 'user' || entry.role === 'assistant');
}

export function timelineMessagesFromEntries(entries: AgentTimelineEntry[]): AgentTimelineMessage[] {
  return entries.filter(isAgentTimelineMessage);
}

export function timelineEntryFromHistoryCell(cell: HistoryCellModel): AgentTimelineEntry {
  if (cell.kind === 'system') {
    return {
      id: timelineEntryIdFromHistoryCell(cell),
      type: 'notice',
      text: cell.text,
      ...(cell.timestamp ? { createdAt: cell.timestamp } : {}),
    };
  }
  return {
    id: timelineEntryIdFromHistoryCell(cell),
    type: 'message',
    role: cell.kind,
    text: cell.text,
    status: 'completed',
    ...(cell.timestamp ? { createdAt: cell.timestamp } : {}),
  };
}

export function timelineEntriesFromHistory(history: HistoryCellModel[]): AgentTimelineEntry[] {
  return history.map(timelineEntryFromHistoryCell);
}

export function timelineEntryIdFromOperationEvent(event: LocalAgentOperationEvent) {
  return `${event.requestId}:operation:${buildOperationPresentation(event).operationKey}`;
}

export function operationTimelineEntryFromEvent(
  event: LocalAgentOperationEvent,
  now: number,
  previous?: AgentOperationEntry,
): AgentOperationEntry {
  const presentation = buildOperationPresentation(event);
  return {
    ...presentation,
    id: previous?.id ?? timelineEntryIdFromOperationEvent(event),
    type: 'operation',
    requestId: event.requestId,
    phase: event.phase,
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    ...(isTerminalOperationPhase(event.phase) ? { completedAt: now } : {}),
  };
}

export function isTerminalOperationPhase(
  phase: LocalAgentOperationPhase,
): phase is Extract<LocalAgentOperationPhase, 'completed' | 'failed' | 'interrupted'> {
  return phase === 'completed' || phase === 'failed' || phase === 'interrupted';
}

export function isRunningOperationPhase(
  phase: LocalAgentOperationPhase,
): phase is Extract<LocalAgentOperationPhase, 'started' | 'updated'> {
  return phase === 'started' || phase === 'updated';
}
