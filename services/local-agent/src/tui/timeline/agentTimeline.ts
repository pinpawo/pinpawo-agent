import type { LocalAgentOperationEvent, LocalAgentOperationPhase } from '../../events/localAgentEvent';
import type { MessageCellModel } from '../state/tuiState';
import {
  buildOperationPresentation,
  type OperationPresentation,
} from './operationPresentation';

export type AgentTimelineEntry =
  | AgentMessageEntry
  | AgentOperationEntry;

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
  role: 'user' | 'assistant';
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

export function timelineEntryIdFromMessageCell(cell: Pick<MessageCellModel, 'id'>) {
  return `message:${cell.id}`;
}

export function isAgentTimelineMessage(entry: AgentTimelineEntry): entry is AgentTimelineMessage {
  return entry.type === 'operation' || entry.type === 'message';
}

export function timelineMessagesFromEntries(entries: AgentTimelineEntry[]): AgentTimelineMessage[] {
  return entries.filter(isAgentTimelineMessage);
}

export function timelineEntryFromMessageCell(cell: MessageCellModel): AgentTimelineEntry | null {
  if (cell.kind === 'system') return null;
  return {
    id: timelineEntryIdFromMessageCell(cell),
    type: 'message',
    role: cell.kind,
    ...(cell.requestId ? { requestId: cell.requestId } : {}),
    text: cell.text,
    status: 'completed',
    ...(cell.timestamp ? { createdAt: cell.timestamp } : {}),
  };
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
  const mergedPresentation = previous
    ? mergeOperationPresentation(event, presentation, previous)
    : presentation;
  return {
    ...mergedPresentation,
    id: previous?.id ?? timelineEntryIdFromOperationEvent(event),
    type: 'operation',
    requestId: event.requestId,
    phase: event.phase,
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    ...(isTerminalOperationPhase(event.phase) ? { completedAt: now } : {}),
  };
}

function mergeOperationPresentation(
  event: LocalAgentOperationEvent,
  presentation: OperationPresentation,
  previous: AgentOperationEntry,
): OperationPresentation {
  return {
    ...presentation,
    title: event.operation.title !== undefined ? presentation.title : previous.title,
    target: event.operation.target !== undefined ? presentation.target : previous.target,
    summary: event.operation.summary !== undefined ? presentation.summary : previous.summary,
    details: event.operation.details !== undefined ? presentation.details : previous.details,
    source: event.operation.source !== undefined ? presentation.source : previous.source,
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
