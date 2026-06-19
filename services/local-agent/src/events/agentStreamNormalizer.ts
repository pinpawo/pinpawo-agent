import type {
  SubagentToolOperationMetadata,
} from '@pinpawo/pet-agent';
import { readJsonRecord } from '@pinpawo/pet-agent';
import type {
  LocalAgentOperationInternalEvent,
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

function summarizeInput(
  summarize: ((input: unknown) => OperationSummary | null) | undefined,
  input: unknown,
): OperationSummary | null | undefined {
  if (!summarize) return undefined;
  const record = typeof input === 'string' ? readJsonRecord(input) : null;
  if (record) {
    return summarize(record) ?? summarize(input);
  }
  return summarize(input);
}

function summarizeOutput(
  summarize: ((output: unknown) => OperationSummary | null) | undefined,
  output: unknown,
): OperationSummary | null | undefined {
  if (!summarize) return undefined;
  const summary = summarize(output);
  if (summary) return summary;
  const record = typeof output === 'string' ? readJsonRecord(output) : null;
  return record ? summarize(record) : summary;
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
  const summary = [
    summarizeInput(metadata?.summarizeInput, payload.input),
    summarizeOutput(metadata?.summarizeOutput, output),
    metadata?.summarizeError?.(payload.error),
  ].reduce(mergeSummary, {});

  return {
    type: 'operation',
    requestId,
    phase: readToolPhase(payload.event),
    operation: {
      id: payload.toolCallId,
      kind: operationKindFromSource(metadata?.source, payload.name),
      title: metadata?.title ?? metadata?.titleKey ?? payload.name,
      target: summary.target,
      summary: summary.summary,
      details: summary.details,
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
