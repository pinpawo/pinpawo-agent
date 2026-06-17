import type {
  SubagentToolOperationMetadata,
} from '@pinpawo/pet-agent';
import type {
  LocalAgentOperationInternalEvent,
  LocalAgentOperationOutputSummary,
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
  operation?: SubagentToolOperationMetadata;
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

function mergeOutputSummary(
  current: LocalAgentOperationOutputSummary,
  next: LocalAgentOperationOutputSummary | null | undefined,
): LocalAgentOperationOutputSummary {
  if (!next) return current;
  const logs = [
    ...(current.logs ?? []),
    ...(next.logs ?? []),
  ];
  const warnings = [
    ...(current.warnings ?? []),
    ...(next.warnings ?? []),
  ];
  const errors = [
    ...(current.errors ?? []),
    ...(next.errors ?? []),
  ];
  return {
    ...current,
    ...next,
    details: current.details || next.details
      ? {
          ...current.details,
          ...next.details,
        }
      : undefined,
    metrics: current.metrics || next.metrics
      ? {
          ...current.metrics,
          ...next.metrics,
      }
      : undefined,
    ...(logs.length > 0 ? { logs } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function outputFromSummary(
  summary: OperationSummary,
): LocalAgentOperationOutputSummary {
  return mergeOutputSummary(
    {
      ...(summary.target ? { target: summary.target } : {}),
      ...(summary.summary ? { summary: summary.summary } : {}),
      ...(summary.details ? { details: summary.details } : {}),
    },
    summary.output,
  );
}

function statusForPhase(phase: LocalAgentOperationPhase): LocalAgentOperationOutputSummary['status'] {
  if (phase === 'started' || phase === 'updated') return 'running';
  return phase;
}

function operationKindFromSource(
  source: NonNullable<SubagentToolOperationMetadata['source']> | undefined,
  fallbackToolName: string,
) {
  const provider = source?.provider ?? 'runtime';
  const ownerName = source?.name ?? provider;
  const toolName = source?.toolName ?? fallbackToolName;
  return `${ownerName}.${toolName}`;
}

export function normalizeToolStreamEvent(
  requestId: string,
  payload: StreamToolsPayload,
  registry: OperationRegistry = emptyOperationRegistry,
): LocalAgentOperationInternalEvent {
  const metadata = payload.operation
    ? {
        ...payload.operation,
        source: payload.operation.source ?? {
          provider: 'runtime' as const,
          name: 'runtime',
          toolName: payload.name,
        },
      }
    : registry.resolveToolOperation(payload.name);
  const output = payload.output !== undefined ? payload.output : payload.data;
  const phase = readToolPhase(payload.event);
  const summary = [
    metadata?.summarizeInput?.(payload.input),
    metadata?.summarizeOutput?.(output),
    metadata?.summarizeError?.(payload.error),
  ].reduce(mergeSummary, {});
  const outputSummary = {
    ...outputFromSummary(summary),
    status: statusForPhase(phase),
  };

  return {
    type: 'operation',
    requestId,
    phase,
    operation: {
      id: payload.toolCallId,
      kind: operationKindFromSource(metadata?.source, payload.name),
      title: metadata?.title ?? metadata?.titleKey ?? payload.name,
      target: summary.target,
      summary: summary.summary,
      details: summary.details,
      output: outputSummary,
      source: {
        provider: metadata?.source.provider ?? 'runtime',
        name: metadata?.source.name ?? 'runtime',
        toolName: metadata?.source.toolName ?? payload.name,
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
