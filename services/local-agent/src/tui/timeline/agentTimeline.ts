import type { LocalAgentOperationEvent } from '../../events/localAgentEvent';
import type {
  LocalAgentMessageEntry,
  LocalAgentOperationEntry,
  LocalAgentTimelineEntry,
} from '../../localAgentSession';
import type { MessageCellModel } from '../state/tuiState';
import {
  localAgentOperationEntryFromEvent,
  localAgentOperationEntryId,
} from '../../localAgentTimeline';

export {
  isRunningOperationPhase,
  isTerminalOperationPhase,
} from '../../localAgentTimeline';

export type AgentTimelineEntry = LocalAgentTimelineEntry;

export type AgentTimelineMessage =
  | AgentUserTimelineMessage
  | AgentAssistantTimelineMessage
  | AgentSystemTimelineMessage
  | AgentSubagentTimelineMessage
  | AgentToolTimelineMessage;

export type AgentUserTimelineMessage = LocalAgentMessageEntry & {
  role: 'user';
  status: 'completed';
};

export type AgentAssistantTimelineMessage = LocalAgentMessageEntry & {
  role: 'assistant';
};

export type AgentSystemTimelineMessage = LocalAgentMessageEntry & {
  role: 'system';
  status: 'completed';
};

export type AgentSubagentTimelineMessage = LocalAgentMessageEntry & {
  role: 'subagent';
  requestId: string;
};

export type AgentToolTimelineMessage = AgentOperationEntry;

export type AgentMessageEntry = LocalAgentMessageEntry;

export type AgentOperationEntry = LocalAgentOperationEntry;

export function timelineEntryIdFromMessageCell(cell: Pick<MessageCellModel, 'id'>) {
  return `message:${cell.id}`;
}

export function isAgentTimelineMessage(entry: AgentTimelineEntry): entry is AgentTimelineMessage {
  return entry.type === 'operation' || entry.type === 'message';
}

export function timelineMessagesFromEntries(entries: AgentTimelineEntry[]): AgentTimelineMessage[] {
  return entries.filter(isAgentTimelineMessage);
}

export function timelineEntryFromMessageCell(cell: MessageCellModel): AgentMessageEntry {
  return {
    id: timelineEntryIdFromMessageCell(cell),
    type: 'message',
    role: cell.kind,
    ...(cell.requestId ? { requestId: cell.requestId } : {}),
    text: cell.text,
    status: 'completed',
    source: cell.kind === 'user' ? 'local-input' : 'live-event',
    ...(cell.timestamp ? { createdAt: cell.timestamp } : {}),
  };
}

export function timelineEntryIdFromOperationEvent(event: LocalAgentOperationEvent) {
  return localAgentOperationEntryId(event);
}

export function operationTimelineEntryFromEvent(
  event: LocalAgentOperationEvent,
  now: number,
  previous?: AgentOperationEntry,
): AgentOperationEntry {
  return localAgentOperationEntryFromEvent(event, now, previous);
}
