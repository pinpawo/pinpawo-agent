import type { LocalAgentOperationEvent } from '../../events/localAgentEvent';

export type OperationPresentation = {
  operationKey: string;
  kind: string;
  title: string;
  phase: LocalAgentOperationEvent['phase'];
  target?: string;
  summary?: string;
  details?: Record<string, unknown>;
  source?: LocalAgentOperationEvent['operation']['source'];
};

export function getOperationPresentationKey(event: LocalAgentOperationEvent) {
  return event.operation.id
    ?? event.operation.source?.callId
    ?? event.operation.source?.name
    ?? event.operation.kind;
}

export function buildOperationPresentation(event: LocalAgentOperationEvent): OperationPresentation {
  return {
    operationKey: getOperationPresentationKey(event),
    kind: event.operation.kind,
    title: event.operation.title ?? event.operation.kind,
    phase: event.phase,
    target: event.operation.target,
    summary: event.operation.summary,
    details: event.operation.details,
    source: event.operation.source,
  };
}
