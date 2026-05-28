import type {
  LocalAgentOperationEvent,
  LocalAgentOperationPhase,
} from './localAgentEvent';
import {
  emptyOperationRegistry,
  type OperationRegistry,
  type OperationSummary,
} from './operationRegistry';

export type StreamToolsPayload = {
  event: 'on_tool_start' | 'on_tool_event' | 'on_tool_end' | 'on_tool_error';
  toolCallId?: string;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  data?: unknown;
};

function readToolPhase(event: StreamToolsPayload['event']): LocalAgentOperationPhase {
  if (event === 'on_tool_start') return 'started';
  if (event === 'on_tool_end') return 'completed';
  if (event === 'on_tool_error') return 'failed';
  return 'updated';
}

function mergeSummary(
  current: OperationSummary,
  next: OperationSummary | null | undefined,
): OperationSummary {
  if (!next) return current;
  return {
    ...current,
    ...next,
    details: current.details || next.details
      ? {
          ...current.details,
          ...next.details,
        }
      : undefined,
  };
}

export function normalizeToolStreamEvent(
  requestId: string,
  payload: StreamToolsPayload,
  registry: OperationRegistry = emptyOperationRegistry,
): LocalAgentOperationEvent {
  const metadata = registry.resolveTool(payload.name);
  const output = payload.output !== undefined ? payload.output : payload.data;
  const summary = [
    metadata?.summarizeInput?.(payload.input),
    metadata?.summarizeOutput?.(output),
    metadata?.summarizeError?.(payload.error),
  ].reduce(mergeSummary, {});

  return {
    type: 'operation',
    requestId,
    phase: readToolPhase(payload.event),
    operation: {
      id: payload.toolCallId,
      kind: metadata?.kind ?? 'tool.execute',
      title: metadata?.title ?? metadata?.titleKey ?? payload.name,
      target: summary.target,
      summary: summary.summary,
      details: summary.details,
      source: {
        provider: metadata?.source.provider ?? 'runtime',
        name: metadata?.source.name ?? payload.name,
        callId: payload.toolCallId,
      },
    },
    raw: {
      input: payload.input,
      output,
      error: payload.error,
    },
  };
}
