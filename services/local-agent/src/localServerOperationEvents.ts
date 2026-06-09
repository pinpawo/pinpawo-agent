import type { StreamToolsPayload } from './agentStreamEvents';
import type { LocalAgentOperationInternalEvent } from './events/localAgentEvent';
import {
  acceptInflightToolEvent,
  emitInflightOperationEvent,
  type InflightOperationRun,
} from './inflightOperationRun';

type EmitEvent = (event: LocalAgentOperationInternalEvent) => void;
type Log = (message: string) => void;

function maybeTrimForLog(value: string | undefined, max = 300) {
  if (!value) return value;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function stringifyLogValue(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    const content = (value as { content?: unknown }).content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === 'string' ? part : ((part as { text?: string }).text ?? '')))
        .join('');
    }
  }
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return String(value);
  }
}

export function isHumanReviewInterruptError(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  const interrupts = Array.isArray(record.interrupts)
    ? record.interrupts
    : Array.isArray(record.__interrupt__)
      ? record.__interrupt__
      : [];
  return interrupts.some((interrupt) => {
    const payload = interrupt && typeof interrupt === 'object' && 'value' in interrupt
      ? (interrupt as { value?: unknown }).value
      : interrupt;
    if (!payload || typeof payload !== 'object') {
      return false;
    }
    const payloadRecord = payload as Record<string, unknown>;
    return payloadRecord.kind === 'review'
      || payloadRecord.kind === 'human_review'
      || (Array.isArray(payloadRecord.actionRequests) && Array.isArray(payloadRecord.reviewConfigs));
  });
}

export function emitLocalServerToolOperationEvent(options: {
  run: InflightOperationRun;
  payload: StreamToolsPayload;
  emit: EmitEvent;
  log?: Log;
}) {
  const { run, payload, emit, log = console.log } = options;
  const event = acceptInflightToolEvent(run, payload);

  if (event.phase === 'failed' && isHumanReviewInterruptError(payload.error)) {
    const interruptedEvent: LocalAgentOperationInternalEvent = {
      ...event,
      phase: 'interrupted' as const,
      raw: {
        input: event.raw?.input,
      },
    };
    emitInflightOperationEvent(interruptedEvent, emit);
    log(`[local-server] operation_interrupted requestId=${run.requestId} kind=${interruptedEvent.operation.kind}`);
    return interruptedEvent;
  }

  const input = event.raw?.input !== undefined ? stringifyLogValue(event.raw.input) : undefined;
  const error = event.raw?.error !== undefined ? stringifyLogValue(event.raw.error) : undefined;
  emitInflightOperationEvent(event, emit);

  log(
    `[local-server] operation_${event.phase} requestId=${run.requestId} kind=${event.operation.kind}`
      + (input ? ` input=${maybeTrimForLog(input, 200)}` : '')
      + (error ? ` error=${maybeTrimForLog(error)}` : ''),
  );

  return event;
}
