import type { JsonObject } from '@pinpawo/agent-contracts';
import type {
  AgentOperationEvent,
  AgentOperationPhase,
  AgentOperationRaw,
} from './events';
import type {
  AgentOperationEntry,
  AgentTimelineEntry,
  AgentTimelineWindow,
} from './domain';

/**
 * The newest `limit` entries, reaching back to `keepFrom` when that index is
 * older, so a window never starts inside the run that is still open. A reader
 * wanting older entries asks again with a larger limit, or none.
 */
export function windowAgentTimeline(
  timeline: readonly AgentTimelineEntry[],
  limit: number,
  keepFrom = timeline.length,
): { timeline: AgentTimelineEntry[]; timelineWindow?: AgentTimelineWindow } {
  const start = Math.max(0, Math.min(timeline.length - limit, keepFrom));
  return start > 0
    ? { timeline: timeline.slice(start), timelineWindow: { omitted: start } }
    : { timeline: [...timeline] };
}


export function agentOperationKey(event: AgentOperationEvent) {
  return event.operation.id
    ?? event.operation.source?.callId
    ?? event.operation.source?.name
    ?? event.operation.kind;
}

export function agentOperationEntryId(event: AgentOperationEvent) {
  return `${event.requestId}:operation:${agentOperationKey(event)}`;
}

export function agentOperationEntryFromEvent(
  event: AgentOperationEvent,
  observedAt: number,
  previous?: AgentOperationEntry,
): AgentOperationEntry {
  const operationKey = agentOperationKey(event);
  const operation = event.operation;
  return {
    id: previous?.id ?? agentOperationEntryId(event),
    type: 'operation',
    requestId: event.requestId,
    operationKey,
    kind: operation.kind,
    title: operation.title ?? previous?.title ?? operation.kind,
    phase: event.phase,
    ...(operation.target !== undefined
      ? { target: operation.target }
      : previous?.target !== undefined
        ? { target: previous.target }
        : {}),
    ...(operation.summary !== undefined
      ? { summary: operation.summary }
      : previous?.summary !== undefined
        ? { summary: previous.summary }
        : {}),
    ...operationDetailsField(previous?.details, operation.details),
    ...(operation.source
      ? { operationSource: operation.source }
      : previous?.operationSource
        ? { operationSource: previous.operationSource }
        : {}),
    startedAt: previous?.startedAt ?? observedAt,
    updatedAt: observedAt,
    ...(isTerminalOperationPhase(event.phase) ? { completedAt: observedAt } : {}),
    ...rawField(mergeOperationRaw(previous?.raw, event.raw)),
  };
}

function operationDetailsField(
  previous: JsonObject | undefined,
  next: JsonObject | undefined,
) {
  if (next === undefined) return previous ? { details: previous } : {};
  if (!previous) return { details: next };
  return { details: { ...previous, ...next } };
}

function mergeOperationRaw(
  previous: AgentOperationRaw | undefined,
  next: AgentOperationRaw | undefined,
) {
  if (!previous) return next;
  if (!next) return previous;
  return {
    ...previous,
    ...(next.input !== undefined ? { input: next.input } : {}),
    ...(next.output !== undefined ? { output: next.output } : {}),
    ...(next.error !== undefined ? { error: next.error } : {}),
  };
}

function rawField(raw: AgentOperationRaw | undefined) {
  return raw ? { raw } : {};
}

export function isTerminalOperationPhase(
  phase: AgentOperationPhase,
): phase is Extract<AgentOperationPhase, 'completed' | 'failed' | 'interrupted'> {
  return phase === 'completed' || phase === 'failed' || phase === 'interrupted';
}

export function isRunningOperationPhase(
  phase: AgentOperationPhase,
): phase is Extract<AgentOperationPhase, 'started' | 'updated'> {
  return phase === 'started' || phase === 'updated';
}
