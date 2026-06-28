import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { RemoveMessage } from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import type {
  ContextPolicyContext,
  SubagentContextPolicy,
  SubagentToolOperationMetadata,
} from '../types/subagent';
import {
  readMessageToolCalls,
  readToolResultCallId,
  type MessageToolCallInfo,
} from '../utils/messages';
import { readMessageText } from '../agent/orchestrator/utils';

const DEFAULT_MIN_SIZE_CHARS = 2000;
const CONTEXT_POLICY_MARKER_KEY = 'contextPolicyRewrite';

type ToolResultCandidate = {
  index: number;
  message: ToolMessage;
  toolName: string | null;
  input: unknown;
  content: string;
  metadata: SubagentToolOperationMetadata | undefined;
  recentProtected: boolean;
};

type RewriteDecision = {
  mode: 'evict' | 'truncate';
};

function collectToolCallInfo(messages: BaseMessage[]) {
  const calls = new Map<string, MessageToolCallInfo>();
  for (const message of messages) {
    if (!AIMessage.isInstance(message)) continue;
    for (const call of readMessageToolCalls(message)) {
      calls.set(call.id, call);
    }
  }
  return calls;
}

function isToolFailure(message: ToolMessage, content: string): boolean {
  return message.status === 'error' || /^Error\b/i.test(content.trim());
}

function summarizeToolInput(toolName: string, input: unknown, metadata: SubagentToolOperationMetadata | undefined): string {
  const summary = metadata?.summarizeInput?.(input);
  const summaryParts = [
    summary?.target,
    summary?.summary,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  if (summaryParts.length > 0) {
    return [toolName, ...summaryParts].join(' ');
  }
  if (input !== undefined) {
    try {
      return `${toolName} ${JSON.stringify(input)}`;
    } catch {
      return toolName;
    }
  }
  return toolName;
}

function buildDefaultStub(candidate: ToolResultCandidate): string {
  const toolName = candidate.toolName ?? 'unknown_tool';
  const fingerprint = summarizeToolInput(toolName, candidate.input, candidate.metadata);
  return `[evicted: ${fingerprint} -> 已读；需要时重新调用]`;
}

function replaceToolMessageContent(
  message: ToolMessage,
  content: string,
  marker: 'evicted' | 'truncated',
): ToolMessage {
  return new ToolMessage({
    id: message.id,
    name: message.name,
    content,
    tool_call_id: message.tool_call_id,
    status: message.status,
    artifact: message.artifact,
    metadata: message.metadata,
    additional_kwargs: {
      ...message.additional_kwargs,
      pinpawo: {
        ...(message.additional_kwargs?.pinpawo && typeof message.additional_kwargs.pinpawo === 'object'
          ? message.additional_kwargs.pinpawo as Record<string, unknown>
          : {}),
        [CONTEXT_POLICY_MARKER_KEY]: marker,
      },
    },
    response_metadata: message.response_metadata,
  });
}

function collectToolResultCandidates(
  messages: BaseMessage[],
  operations: Record<string, SubagentToolOperationMetadata>,
): ToolResultCandidate[] {
  const calls = collectToolCallInfo(messages);
  const toolMessages = messages
    .map((message, index) => ({ message, index }))
    .filter((item): item is { message: ToolMessage; index: number } => ToolMessage.isInstance(item.message));

  return toolMessages.map((item) => {
    const callId = readToolResultCallId(item.message);
    const call = callId ? calls.get(callId) : null;
    const toolName = call?.name ?? (typeof item.message.name === 'string' ? item.message.name : null);
    return {
      index: item.index,
      message: item.message,
      toolName,
      input: call?.args,
      content: readMessageText(item.message),
      metadata: toolName ? operations[toolName] : undefined,
      recentProtected: false,
    };
  });
}

function markRecentProtected(candidates: ToolResultCandidate[], keepRecent: number): ToolResultCandidate[] {
  const recentCount = Math.max(0, keepRecent);
  const protectedIndexes = new Set(
    recentCount > 0
      ? candidates.slice(-recentCount).map((candidate) => candidate.index)
      : [],
  );
  return candidates.map((candidate) => ({
    ...candidate,
    recentProtected: protectedIndexes.has(candidate.index),
  }));
}

function isDefaultEvictionStub(content: string): boolean {
  return /^\[evicted: .+ -> 已读；需要时重新调用\]$/.test(content.trim());
}

function readRewriteMarker(message: ToolMessage): string | null {
  const pinpawo = message.additional_kwargs?.pinpawo;
  if (!pinpawo || typeof pinpawo !== 'object') return null;
  const marker = (pinpawo as Record<string, unknown>)[CONTEXT_POLICY_MARKER_KEY];
  return typeof marker === 'string' ? marker : null;
}

function shouldRewriteCandidate(
  candidate: ToolResultCandidate,
  policy: NonNullable<SubagentContextPolicy['evictToolResults']>,
): RewriteDecision | null {
  const toolName = candidate.toolName ?? '';
  const perTool = toolName ? policy.perTool?.[toolName] : undefined;
  if (perTool === 'keep') return null;
  if (readRewriteMarker(candidate.message) || isDefaultEvictionStub(candidate.content)) return null;

  const minSizeChars = policy.minSizeChars ?? DEFAULT_MIN_SIZE_CHARS;
  if (perTool === 'truncate') {
    return candidate.content.length > minSizeChars
      ? { mode: 'truncate' }
      : null;
  }
  if (candidate.recentProtected) return null;
  if (perTool === 'evict') {
    return { mode: 'evict' };
  }
  if ((policy.keepFailures ?? true) && isToolFailure(candidate.message, candidate.content)) {
    return null;
  }
  if (candidate.content.length < minSizeChars) return null;
  return { mode: policy.defaultMode ?? 'evict' };
}

function rewriteCandidate(
  candidate: ToolResultCandidate,
  mode: 'evict' | 'truncate',
  minSizeChars: number,
): ToolMessage {
  if (mode === 'truncate') {
    return replaceToolMessageContent(candidate.message, `${candidate.content.slice(0, minSizeChars)}\n[truncated: older tool result; recall or rerun tool if needed]`, 'truncated');
  }
  return replaceToolMessageContent(candidate.message, buildDefaultStub(candidate), 'evicted');
}

export function rewriteMessagesForContextPolicy(
  messages: BaseMessage[],
  policy: SubagentContextPolicy | undefined,
  ctx: ContextPolicyContext,
): BaseMessage[] {
  if (!policy) return messages;
  if (policy.rewrite) {
    return policy.rewrite(messages, ctx);
  }
  const evictPolicy = policy.evictToolResults;
  if (!evictPolicy) return messages;
  if (ctx.providerUsageWatermark?.triggered !== true) return messages;

  const minSizeChars = evictPolicy.minSizeChars ?? DEFAULT_MIN_SIZE_CHARS;
  const candidates = markRecentProtected(
    collectToolResultCandidates(messages, ctx.operations),
    evictPolicy.keepRecent,
  );
  const nextMessages = [...messages];
  let changed = false;

  for (const candidate of candidates) {
    const decision = shouldRewriteCandidate(candidate, evictPolicy);
    if (!decision) continue;

    const rewritten = rewriteCandidate(candidate, decision.mode, minSizeChars);
    nextMessages[candidate.index] = rewritten;
    changed = true;
  }

  return changed ? nextMessages : messages;
}

export function buildContextPolicyStateUpdate(
  originalMessages: BaseMessage[],
  rewrittenMessages: BaseMessage[],
): { messages: BaseMessage[] } | undefined {
  if (rewrittenMessages === originalMessages) return undefined;
  if (rewrittenMessages.length === originalMessages.length
    && rewrittenMessages.every((message, index) => message === originalMessages[index])) {
    return undefined;
  }
  return {
    messages: [
      new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
      ...rewrittenMessages,
    ] as BaseMessage[],
  };
}
