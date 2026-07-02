import { isBaseMessage } from '@langchain/core/messages';
import type {
  SubagentToolOperationMetadata,
} from '@pinpawo/pet-agent';
import {
  readHumanReviewRejectedToolResult,
  readJsonRecord,
} from '@pinpawo/pet-agent';
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

/** Flatten a message `content` (string | content-block array) to display text. */
function messageContentToText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part
          && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return null;
}

/**
 * LangChain's `streamMode: 'tools'` emits `on_tool_end` with `output` set to the
 * full ToolMessage (`_formatToolOutput` wraps a tool's string return into a
 * ToolMessage when a tool_call_id is present). Streaming/displaying that object
 * verbatim leaks the serialized envelope (`{"lc":1,"type":"constructor","id":
 * ["langchain_core","messages",...]}`) instead of the tool's actual content.
 * Unwrap to the message content so consumers see the real output. Non-message
 * outputs (plain strings, plain records) pass through untouched.
 *
 * `output` may arrive as either a live BaseMessage instance (the common stream
 * path) or its serialized `{lc,type,id,kwargs}` form (e.g. after checkpoint
 * round-trips). LangChain's `isBaseMessage` only recognizes the instance form
 * (it duck-types on `_getType`), so the serialized form is handled explicitly.
 */
function unwrapToolMessageOutput(output: unknown): unknown {
  // Instance form: let LangChain decide what a message is, then read its content.
  if (isBaseMessage(output)) {
    return messageContentToText(output.content) ?? output;
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return output;
  }
  // Serialized form: { lc, type:'constructor', id:[...,'messages',...], kwargs }
  // with the payload under kwargs.content.
  const record = output as Record<string, unknown>;
  const serializedId = record.lc !== undefined && Array.isArray(record.id) ? record.id : null;
  if (
    serializedId
    && serializedId.includes('messages')
    && record.kwargs
    && typeof record.kwargs === 'object'
  ) {
    const text = messageContentToText((record.kwargs as Record<string, unknown>).content);
    if (text !== null) {
      return text;
    }
  }
  return output;
}

function readToolPhase(
  event: StreamToolsPayload['event'],
  options: { interrupted?: boolean } = {},
): LocalAgentOperationPhase {
  if (options.interrupted) return 'interrupted';
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
  const output = unwrapToolMessageOutput(
    payload.output !== undefined ? payload.output : payload.data,
  );
  const rejectedToolResult = readHumanReviewRejectedToolResult(output);
  const normalizedOutput = rejectedToolResult ? undefined : output;
  const normalizedError = rejectedToolResult?.reason ?? payload.error;
  const summary = [
    summarizeInput(metadata?.summarizeInput, payload.input),
    summarizeOutput(metadata?.summarizeOutput, normalizedOutput),
    metadata?.summarizeError?.(normalizedError),
  ].reduce(mergeSummary, {});

  return {
    type: 'operation',
    requestId,
    phase: readToolPhase(payload.event, { interrupted: Boolean(rejectedToolResult) }),
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
      output: normalizedOutput,
      error: normalizedError,
    },
  };
}
