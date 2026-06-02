import type { StreamToolsPayload } from './agentStreamEvents';
import type {
  LocalAgentOperationEvent,
  LocalAgentOperationPhase,
} from './events/localAgentEvent';
import { recordOperationActivity } from './operationActivityState';
import { ToolOperationTracker } from './toolOperationTracker';

export type InflightOperationRun = {
  requestId: string;
  controller: AbortController;
  operationTracker: ToolOperationTracker;
  interruptedSent?: boolean;
  interruptTimer?: ReturnType<typeof setTimeout>;
};

export type TerminalOperationPhase = Extract<
  LocalAgentOperationPhase,
  'completed' | 'failed' | 'interrupted'
>;

export type EmitOperationEvent = (event: LocalAgentOperationEvent) => void;

export function createInflightOperationRun(requestId: string): InflightOperationRun {
  return {
    requestId,
    controller: new AbortController(),
    operationTracker: new ToolOperationTracker(requestId),
  };
}

export function clearInflightOperationTimer(run: InflightOperationRun) {
  if (run.interruptTimer) {
    clearTimeout(run.interruptTimer);
    run.interruptTimer = undefined;
  }
}

export function acceptInflightToolEvent(
  run: InflightOperationRun,
  payload: StreamToolsPayload,
): LocalAgentOperationEvent {
  return run.operationTracker.accept(payload);
}

export function emitInflightOperationEvent(
  event: LocalAgentOperationEvent,
  emit: EmitOperationEvent,
) {
  recordOperationActivity(event);
  emit(event);
}

export function emitInflightToolEvent(
  run: InflightOperationRun,
  payload: StreamToolsPayload,
  emit: EmitOperationEvent,
) {
  const event = acceptInflightToolEvent(run, payload);
  emitInflightOperationEvent(event, emit);
  return event;
}

export function finishInflightOperations(
  run: InflightOperationRun,
  phase: TerminalOperationPhase,
  emit: EmitOperationEvent,
  error?: unknown,
) {
  for (const event of run.operationTracker.finishActive(phase, error)) {
    emitInflightOperationEvent(event, emit);
  }
}
