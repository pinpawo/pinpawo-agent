import type {
  LocalAgentOperationEvent,
  LocalAgentOperationPhase,
  LocalAgentOperationRaw,
} from './events/localAgentRuntimeEvent';
import type { LocalAgentOperationEntry } from './localAgentSession';

export function localAgentOperationKey(event: LocalAgentOperationEvent) {
  return event.operation.id
    ?? event.operation.source?.callId
    ?? event.operation.source?.name
    ?? event.operation.kind;
}

export function localAgentOperationEntryId(event: LocalAgentOperationEvent) {
  return `${event.requestId}:operation:${localAgentOperationKey(event)}`;
}

export function localAgentOperationEntryFromEvent(
  event: LocalAgentOperationEvent,
  observedAt: number,
  previous?: LocalAgentOperationEntry,
): LocalAgentOperationEntry {
  const operationKey = localAgentOperationKey(event);
  const operation = event.operation;
  return {
    id: previous?.id ?? localAgentOperationEntryId(event),
    type: 'operation',
    requestId: event.requestId,
    operationKey,
    kind: operation.kind,
    title: operation.title ?? previous?.title ?? operation.kind,
    phase: event.phase,
    source: 'live-event',
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
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
) {
  if (next === undefined) return previous ? { details: previous } : {};
  if (!previous) return { details: next };
  return { details: { ...previous, ...next } };
}

function mergeOperationRaw(
  previous: LocalAgentOperationRaw | undefined,
  next: LocalAgentOperationRaw | undefined,
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

function rawField(raw: LocalAgentOperationRaw | undefined) {
  return raw ? { raw } : {};
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
