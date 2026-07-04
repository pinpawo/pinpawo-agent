import type {
  LocalAgentOperationEvent,
  LocalAgentOperationPhase,
  LocalAgentOperationRaw,
} from '../../events/localAgentEvent';
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
  raw?: LocalAgentOperationRaw;
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
    ...rawField(mergeOperationRaw(previous?.raw, event.raw)),
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
    details: event.operation.details !== undefined
      ? mergeOperationDetails(previous.details, presentation.details)
      : previous.details,
    source: event.operation.source !== undefined ? presentation.source : previous.source,
  };
}

function mergeOperationDetails(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
) {
  if (!previous) return next;
  if (!next) return previous;
  return { ...previous, ...next };
}

function mergeOperationRaw(
  previous: LocalAgentOperationRaw | undefined,
  next: LocalAgentOperationRaw | undefined,
) {
  if (!previous) return next;
  if (!next) return previous;
  return {
    ...previous,
    ...definedRawFields(next),
  };
}

function rawField(raw: LocalAgentOperationRaw | undefined) {
  return raw ? { raw } : {};
}

function definedRawFields(raw: LocalAgentOperationRaw) {
  return {
    ...(raw.input !== undefined ? { input: raw.input } : {}),
    ...(raw.output !== undefined ? { output: raw.output } : {}),
    ...(raw.error !== undefined ? { error: raw.error } : {}),
  };
}

/**
 * Weave the previous timeline's operation entries into a snapshot-derived
 * timeline (#322 Phase 5).
 *
 * The snapshot is the CONVERSATION authority (checkpoint messages), but it
 * knows nothing about tool operations — those are execution-process events
 * that only exist in the live root-stream projection. Replacing the timeline
 * wholesale on reconcile/reconnect would erase them from state (transcript
 * export, re-render and resume would lose the operation history even though
 * the terminal scrollback still shows the lines).
 *
 * Merge walk: scan the previous timeline in order, matching its message
 * entries against the snapshot messages by (role, trimmed text) with a
 * forward-only cursor — snapshot messages get fresh ids on every load, so
 * identity cannot anchor. Each operation entry is re-inserted after the
 * cursor's current snapshot position, preserving relative order. Operations
 * whose surrounding messages no longer exist in the snapshot (history
 * truncation) stay attached to the last matched position.
 */
export function mergeOperationEntriesIntoTimeline(
  previous: AgentTimelineEntry[],
  next: AgentTimelineEntry[],
): AgentTimelineEntry[] {
  const previousOperations = previous.filter((entry) => entry.type === 'operation');
  if (previousOperations.length === 0) {
    return next;
  }
  const nextIds = new Set(next.map((entry) => entry.id));

  // insertions[i] = operations to place AFTER next[i - 1] (i = 0 → before all).
  const insertions = new Map<number, AgentOperationEntry[]>();
  let cursor = 0;
  for (const entry of previous) {
    if (entry.type === 'message') {
      const matched = findMessageForward(next, cursor, entry);
      if (matched >= 0) {
        cursor = matched + 1;
      }
      continue;
    }
    if (nextIds.has(entry.id)) {
      // The snapshot already carries this operation; it owns placement.
      continue;
    }
    const group = insertions.get(cursor) ?? [];
    group.push(entry);
    insertions.set(cursor, group);
  }

  const merged: AgentTimelineEntry[] = [];
  for (let index = 0; index <= next.length; index += 1) {
    const group = insertions.get(index);
    if (group) {
      merged.push(...group);
    }
    const entry = next[index];
    if (entry) {
      merged.push(entry);
    }
  }
  return merged;
}

function findMessageForward(
  entries: AgentTimelineEntry[],
  from: number,
  message: AgentMessageEntry,
): number {
  const text = message.text.trim();
  for (let index = from; index < entries.length; index += 1) {
    const candidate = entries[index];
    if (
      candidate?.type === 'message'
      && candidate.role === message.role
      && candidate.text.trim() === text
    ) {
      return index;
    }
  }
  return -1;
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
