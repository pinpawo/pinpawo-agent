import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage } from '@langchain/core/messages';
import {
  createTokenUsageSnapshot,
  GLOBAL_REVIEW_POLICY_RUNTIME_EVENT,
  isHumanReviewInterruptPayload,
  isOrchestratorInternalAiStreamNode,
  readMessagesTokenUsage,
  type ReviewSpec,
  type SubagentToolEvent,
  type SubagentToolLifecycleEvent,
} from '@pinpawo/pet-agent';
import type { AgentChannelSetup } from './agentChannel';
import type { LocalAgentGraphService } from './agentGraphService';
import type { LocalAgentEvent } from './events/localAgentEvent';
import {
  isLaneTaggedAiMessage,
  readFinalMessageText,
  readMessageChunkText,
  readStreamNode,
  type StreamToolsPayload,
} from './agentStreamEvents';
import { clearAgentRunActivity, recordAgentRunActivity } from './operationActivityState';

const DEFAULT_CONTEXT_WINDOW_TOKENS = 32000;
const STALE_RESUME_MESSAGE = '这个 review 已关闭或不存在，请等待当前确认面板刷新后再应答。';
const PENDING_REVIEW_TEXT_NOTICE = '当前有待确认的 review，请先通过确认面板应答；这条文本没有作为新消息发送。';

export type ChatSessionResult =
  | { status: 'completed'; reply: string }
  | { status: 'waiting_human' }
  | { status: 'interrupted' };

export type ChatSessionRequest =
  | { kind: 'user_message'; requestId: string; message: string }
  | { kind: 'resume'; requestId: string; resume: unknown };

export type ChatSessionAdapterOptions = {
  request: ChatSessionRequest;
  setup: AgentChannelSetup;
  graphService: LocalAgentGraphService;
  isCurrent: () => boolean;
  finishInterrupted: () => void;
  emitEvent: (event: LocalAgentEvent) => void;
  emitToolEvent: (payload: StreamToolsPayload) => void;
};

function throwUnexpectedInterruptPayload(): never {
  throw new Error('Received an interrupt without canonical human review payload.');
}

function emitHumanReviewRequested(params: {
  review: ReviewSpec;
  requestId: string;
  emitEvent: (event: LocalAgentEvent) => void;
}) {
  recordAgentRunActivity('waiting_human', params.requestId);
  params.emitEvent({
    type: 'human_review.requested',
    requestId: params.requestId,
    review: params.review,
  });
}

function isToolLifecycleEvent(event: SubagentToolEvent): event is SubagentToolLifecycleEvent {
  return event.event === 'on_tool_start'
    || event.event === 'on_tool_event'
    || event.event === 'on_tool_end'
    || event.event === 'on_tool_error';
}

function readRuntimeEventData(event: SubagentToolEvent): Record<string, unknown> | null {
  return event.event === 'on_runtime_event'
    && event.data
    && typeof event.data === 'object'
    && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : null;
}

function formatToolAuthorizationNotice(event: SubagentToolEvent): string | null {
  if (
    event.event === 'on_runtime_event'
    && event.name === GLOBAL_REVIEW_POLICY_RUNTIME_EVENT.AUTO_AUTHORIZED
  ) {
    const data = readRuntimeEventData(event);
    const toolName = typeof data?.toolName === 'string' ? data.toolName : null;
    return toolName
      ? `已自动授权 ${toolName} 操作。`
      : '已自动授权工具操作。';
  }
  if (
    event.event === 'on_runtime_event'
    && event.name === GLOBAL_REVIEW_POLICY_RUNTIME_EVENT.CUSTOM_AUTHORIZED
  ) {
    const data = readRuntimeEventData(event);
    const toolName = typeof data?.toolName === 'string' ? data.toolName : null;
    return toolName
      ? `已根据全局策略授权 ${toolName} 操作。`
      : '已根据全局策略授权工具操作。';
  }
  if (event.event !== 'on_runtime_event' || event.name !== 'tool_authorization_recorded') {
    return null;
  }
  const data = readRuntimeEventData(event);
  const authorizations = Array.isArray(data?.authorizations) ? data.authorizations : [];
  const toolNames = [...new Set(authorizations
    .map((item) => item && typeof item === 'object'
      ? (item as { toolName?: unknown }).toolName
      : null)
    .filter((toolName): toolName is string => typeof toolName === 'string' && toolName.trim().length > 0))];

  if (toolNames.length === 1) {
    return `已授权当前会话中的 ${toolNames[0]} 操作。`;
  }
  if (toolNames.length > 1) {
    return `已授权当前会话中的 ${toolNames.length} 个工具操作。`;
  }
  return '已授权当前会话中的工具操作。';
}

function readSubagentMessageDelta(event: SubagentToolEvent): string | null {
  if (event.event !== 'on_runtime_event' || event.name !== 'subagent_message_delta') {
    return null;
  }
  const data = readRuntimeEventData(event);
  const text = data && typeof data.text === 'string' ? data.text : null;
  return text && text.length > 0 ? text : null;
}

function readMessageId(message: BaseMessage): string | null {
  return typeof message.id === 'string' && message.id.trim() ? message.id : null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function messageFingerprint(message: BaseMessage): string {
  return safeJson([
    message._getType(),
    message.name ?? null,
    message.content,
  ]);
}

function buildInitialMessageIndex(messages: BaseMessage[]) {
  const ids = new Set<string>();
  const fingerprints = new Map<string, number>();
  for (const message of messages) {
    const id = readMessageId(message);
    if (id) {
      ids.add(id);
      continue;
    }
    const fingerprint = messageFingerprint(message);
    fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + 1);
  }
  return { ids, fingerprints };
}

function readRunMessages(initialMessages: BaseMessage[], finalMessages: BaseMessage[]) {
  const initial = buildInitialMessageIndex(initialMessages);
  return finalMessages.filter((message) => {
    const id = readMessageId(message);
    if (id) {
      return !initial.ids.has(id);
    }

    const fingerprint = messageFingerprint(message);
    const count = initial.fingerprints.get(fingerprint) ?? 0;
    if (count > 0) {
      initial.fingerprints.set(fingerprint, count - 1);
      return false;
    }
    return true;
  });
}

function readRunTokenUsage(params: {
  initialMessages: BaseMessage[];
  finalMessages: BaseMessage[];
  contextWindow: number;
}) {
  const runMessages = readRunMessages(params.initialMessages, params.finalMessages);
  return createTokenUsageSnapshot(
    readMessagesTokenUsage(runMessages),
    params.contextWindow,
  );
}

export async function runChatSession(options: ChatSessionAdapterOptions): Promise<ChatSessionResult> {
  const { request, setup, graphService, isCurrent, finishInterrupted, emitEvent, emitToolEvent } = options;
  const { requestId } = request;
  const isResumeRequest = request.kind === 'resume';
  const message = request.kind === 'user_message' ? request.message : '';

  const initialThreadState = await graphService.readThreadState(setup);
  if (!isCurrent()) {
    finishInterrupted();
    return { status: 'interrupted' };
  }

  if (initialThreadState.pendingHumanReview && !isResumeRequest) {
    if (message.trim()) {
      emitEvent({
        type: 'system.notice',
        requestId,
        message: PENDING_REVIEW_TEXT_NOTICE,
      });
    }
    emitHumanReviewRequested({
      review: initialThreadState.pendingHumanReview.review,
      requestId,
      emitEvent,
    });
    return { status: 'waiting_human' };
  }

  if (isResumeRequest && !initialThreadState.hasPendingContinuation) {
    throw new Error(STALE_RESUME_MESSAGE);
  }

  const graphInput = isResumeRequest
    ? graphService.buildResumeCommand(request.resume)
    : undefined;
  if (!isResumeRequest) {
    setup.input.messages = [
      ...setup.input.messages.slice(0, -1),
      new HumanMessage(message),
    ];
  }

  setup.input.onToolEvent = (event) => {
    if (isCurrent()) {
      const notice = formatToolAuthorizationNotice(event);
      if (notice) {
        emitEvent({
          type: 'system.notice',
          requestId,
          message: notice,
        });
        return;
      }
      const subagentText = readSubagentMessageDelta(event);
      if (subagentText) {
        emitEvent({
          type: 'subagent.message.delta',
          requestId,
          text: subagentText,
        });
        return;
      }
      if (isToolLifecycleEvent(event)) {
        emitToolEvent(event as StreamToolsPayload);
      }
    }
  };

  let finalMessages: BaseMessage[] = [];
  let streamedReply = '';
  try {
    const streamRun = graphService.stream(setup, graphInput);
    for await (const chunk of streamRun) {
      if (!isCurrent()) {
        finishInterrupted();
        return { status: 'interrupted' };
      }

      if (!Array.isArray(chunk)) {
        continue;
      }

      const [mode, payload] = chunk as [string, unknown];

      if (mode === 'messages' && Array.isArray(payload)) {
        const [streamMessage, metadata] = payload as [BaseMessage, Record<string, unknown> | undefined];
        if (streamMessage._getType() !== 'ai') {
          continue;
        }
        const streamNode = readStreamNode(metadata);
        if (streamNode && isOrchestratorInternalAiStreamNode(streamNode)) {
          continue;
        }
        if (isLaneTaggedAiMessage(streamMessage)) {
          continue;
        }
        const chunkText = readMessageChunkText(streamMessage);
        if (!chunkText) {
          continue;
        }
        const token = chunkText.startsWith(streamedReply)
          ? chunkText.slice(streamedReply.length)
          : chunkText;
        if (!token) {
          continue;
        }
        streamedReply += token;
        recordAgentRunActivity('streaming', requestId);
        emitEvent({
          type: 'message.delta',
          requestId,
          role: 'assistant',
          text: token,
        });
        continue;
      }

      if (mode === 'values' && payload && typeof payload === 'object' && 'messages' in payload) {
        finalMessages = ((payload as { messages?: BaseMessage[] }).messages ?? []);
        continue;
      }

      if (mode === 'values' && payload && typeof payload === 'object' && '__interrupt__' in payload) {
        const interruptPayload = readFirstHumanReviewInterruptPayload(payload);
        if (interruptPayload) {
          emitHumanReviewRequested({
            review: interruptPayload.review,
            requestId,
            emitEvent,
          });
          return { status: 'waiting_human' };
        }
      }
    }
  } finally {
    setup.input.onToolEvent = undefined;
  }

  if (!isCurrent()) {
    finishInterrupted();
    return { status: 'interrupted' };
  }

  const finalThreadState = await graphService.readThreadState(setup);
  if (!isCurrent()) {
    finishInterrupted();
    return { status: 'interrupted' };
  }

  if (finalThreadState.pendingHumanReview) {
    emitHumanReviewRequested({
      review: finalThreadState.pendingHumanReview.review,
      requestId,
      emitEvent,
    });
    return { status: 'waiting_human' };
  }

  const streamedFinalReply = finalMessages.length > 0
    ? readFinalMessageText(finalMessages.at(-1) ?? {})
    : '';
  const checkpointFinalReply = readFinalMessageText(finalThreadState.messages.at(-1) ?? {});
  const finalReply = streamedFinalReply || checkpointFinalReply;
  const contextWindow = setup.graphConfig.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const finalUsage = readRunTokenUsage({
    initialMessages: initialThreadState.messages,
    finalMessages: finalThreadState.messages.length > 0 ? finalThreadState.messages : finalMessages,
    contextWindow,
  });
  emitEvent({
    type: 'message.completed',
    requestId,
    role: 'assistant',
    text: finalReply,
    ...(finalUsage ? { usage: finalUsage } : {}),
  });
  clearAgentRunActivity(requestId);

  return { status: 'completed', reply: finalReply };
}

function readFirstHumanReviewInterruptPayload(payload: object): { review: ReviewSpec } | null {
  const rawInterrupts = (payload as { __interrupt__?: unknown }).__interrupt__;
  const firstInterrupt = Array.isArray(rawInterrupts) ? rawInterrupts[0] : null;
  const value = firstInterrupt
    && typeof firstInterrupt === 'object'
    && 'value' in firstInterrupt
    && firstInterrupt.value
    && typeof firstInterrupt.value === 'object'
    ? firstInterrupt.value as Record<string, unknown>
    : null;
  if (!value) {
    return null;
  }
  if (!isHumanReviewInterruptPayload(value)) {
    throwUnexpectedInterruptPayload();
  }
  return {
    review: value.review,
  };
}
