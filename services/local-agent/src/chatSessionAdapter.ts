import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage } from '@langchain/core/messages';
import {
  createTokenUsageSnapshot,
  GLOBAL_REVIEW_POLICY_RUNTIME_EVENT,
  isGraphRecursionLimitError,
  isHumanReviewBatchInterruptPayload,
  isHumanReviewInterruptPayload,
  NamespacedProtocolToolEventReader,
  readLatestProviderInputTokens,
  readMessagesTokenUsage,
  stampMessageCreatedAtUtc,
  SUBAGENT_OPERATIONS_EVENT,
  type ReviewSpec,
  type SubagentToolOperationMetadata,
} from '@pinpawo/pet-agent';
import type { AgentChannelSetup } from './agentChannel';
import type {
  LocalAgentGraphEventStream,
  LocalAgentGraphPendingHumanReview,
  LocalAgentGraphService,
  LocalAgentGraphThreadState,
} from './agentGraphService';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import {
  readFinalMessageText,
  type StreamToolsPayload,
} from './agentStreamEvents';
import {
  adaptRootStream,
  type RootProtocolEvent,
} from './events/rootStreamEventAdapter';
import { clearAgentRunActivity, recordAgentRunActivity } from './operationActivityState';

const DEFAULT_CONTEXT_WINDOW_TOKENS = 32000;
const STALE_RESUME_MESSAGE = '这个 review 已关闭或不存在，请等待当前确认面板刷新后再应答。';
const PENDING_REVIEW_TEXT_NOTICE = '当前有待确认的 review，请先通过确认面板应答；这条文本没有作为新消息发送。';
const RECURSION_LIMIT_NOTICE = '本轮处理步数已达上限，未能在一轮内完成。已保留当前进度，可继续提交下一步让我接着推进。';

export type ChatSessionResult =
  | { status: 'completed'; reply: string }
  | { status: 'waiting_human' }
  | { status: 'interrupted' };

export type ChatSessionRequest =
  | {
      kind: 'user_message';
      requestId: string;
      message: string;
      activeDelegationTransition?: AgentChannelSetup['input']['activeDelegationTransition'];
    }
  | { kind: 'resume'; requestId: string; resume: unknown };

export type ChatSessionAdapterOptions = {
  request: ChatSessionRequest;
  setup: AgentChannelSetup;
  graphService: LocalAgentGraphService;
  isCurrent: () => boolean;
  finishInterrupted: () => void;
  emitEvent: (event: AgentRuntimeEvent) => void;
  emitToolEvent: (payload: StreamToolsPayload) => void;
  /**
   * A review.cancel run stops itself at a safe graph checkpoint. If the active
   * boundary read is transiently unavailable, allow the final settled
   * checkpoint to release the queued interrupt instead of reporting completed.
   */
  interruptOnSettledResumeCheckpoint?: boolean;
  /** Called once checkpoint state no longer contains the original review. */
  onResumeCheckpointed?: (result: { canInterrupt: boolean }) => void;
  /**
   * Receives a delegation's `subagent_operations` announcement so the
   * caller's operation registry can join display metadata for
   * delegation-scoped toolkit tools (#322 Phase 4).
   */
  acceptDelegationOperations?: (operations: Record<string, SubagentToolOperationMetadata>) => void;
};

function throwUnexpectedInterruptPayload(): never {
  throw new Error('Received an interrupt without canonical human review payload.');
}

function normalizeReviewList(review: ReviewSpec, reviews?: ReviewSpec[]): ReviewSpec[] {
  return reviews?.length ? reviews : [review];
}

function pendingReviewSpecIdentity(pending: LocalAgentGraphPendingHumanReview) {
  const reviews = normalizeReviewList(pending.review, pending.reviews);
  return reviews.map((review) => encodeURIComponent(review.id)).join(',');
}

function isSamePendingReview(
  initial: LocalAgentGraphPendingHumanReview,
  current: LocalAgentGraphPendingHumanReview | null,
) {
  if (!current) return false;
  if (initial.interruptId && current.interruptId) {
    return initial.interruptId === current.interruptId;
  }
  return pendingReviewSpecIdentity(initial) === pendingReviewSpecIdentity(current);
}

function originalReviewWasCheckpointed(
  initial: LocalAgentGraphThreadState,
  current: LocalAgentGraphThreadState,
) {
  if (initial.pendingHumanReview) {
    return !isSamePendingReview(initial.pendingHumanReview, current.pendingHumanReview);
  }
  return current.pendingHumanReview !== null || !current.hasPendingContinuation;
}

async function waitForGraphRunSettlement(run: LocalAgentGraphEventStream | null) {
  const output = (run as { output?: PromiseLike<unknown> } | null)?.output;
  if (!output) return;
  try {
    await output;
  } catch {
    // Event iteration remains the canonical error path. Waiting here only
    // ensures an early return does not outlive the underlying graph run.
  }
}

function emitHumanReviewRequested(params: {
  interruptId?: string;
  reviews: ReviewSpec[];
  requestId: string;
  emitEvent: (event: AgentRuntimeEvent) => void;
}) {
  const review = params.reviews[0];
  if (!review) {
    return;
  }
  const reviews = params.reviews;
  recordAgentRunActivity('waiting_human', params.requestId);
  params.emitEvent({
    type: 'human_review.requested',
    requestId: params.requestId,
    ...(params.interruptId ? { interruptId: params.interruptId } : {}),
    review,
    ...(reviews.length > 1 ? { reviews } : {}),
  });
}

function readRuntimeEventData(data: unknown): Record<string, unknown> | null {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
}

/**
 * Toolkit authorization runtime events arrive as `runtime.custom` chat events
 * from the root protocol stream (#322); map the known names to user notices.
 */
function formatToolAuthorizationNotice(name: string, rawData: unknown): string | null {
  if (name === GLOBAL_REVIEW_POLICY_RUNTIME_EVENT.AUTO_AUTHORIZED) {
    const data = readRuntimeEventData(rawData);
    const toolName = typeof data?.toolName === 'string' ? data.toolName : null;
    return toolName
      ? `已自动授权 ${toolName} 操作。`
      : '已自动授权工具操作。';
  }
  if (name === GLOBAL_REVIEW_POLICY_RUNTIME_EVENT.CUSTOM_AUTHORIZED) {
    const data = readRuntimeEventData(rawData);
    const toolName = typeof data?.toolName === 'string' ? data.toolName : null;
    return toolName
      ? `已根据全局策略授权 ${toolName} 操作。`
      : '已根据全局策略授权工具操作。';
  }
  if (name !== 'tool_authorization_recorded') {
    return null;
  }
  const data = readRuntimeEventData(rawData);
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

function readDelegationOperations(data: unknown): Record<string, SubagentToolOperationMetadata> | null {
  const operations = data
    && typeof data === 'object'
    && !Array.isArray(data)
    ? (data as { operations?: unknown }).operations
    : null;
  return operations && typeof operations === 'object' && !Array.isArray(operations)
    ? operations as Record<string, SubagentToolOperationMetadata>
    : null;
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
    readLatestProviderInputTokens(params.finalMessages),
  );
}

export async function runChatSession(options: ChatSessionAdapterOptions): Promise<ChatSessionResult> {
  const {
    request,
    setup,
    graphService,
    isCurrent,
    finishInterrupted,
    emitEvent,
    emitToolEvent,
    acceptDelegationOperations,
  } = options;
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
      ...(initialThreadState.pendingHumanReview.interruptId
        ? { interruptId: initialThreadState.pendingHumanReview.interruptId }
        : {}),
      reviews: normalizeReviewList(
        initialThreadState.pendingHumanReview.review,
        initialThreadState.pendingHumanReview.reviews,
      ),
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
    setup.input.activeDelegationTransition = request.activeDelegationTransition;
    setup.input.messages = [
      ...setup.input.messages.slice(0, -1),
      stampMessageCreatedAtUtc(new HumanMessage(message)),
    ];
  }

  let finalMessages: BaseMessage[] = [];
  let streamedReply = '';
  let resumeCheckpointed = false;
  const confirmResumeCheckpoint = (state: LocalAgentGraphThreadState, runIsActive: boolean) => {
    if (
      !isResumeRequest
      || !options.onResumeCheckpointed
      || resumeCheckpointed
      || !originalReviewWasCheckpointed(initialThreadState, state)
    ) {
      return;
    }
    resumeCheckpointed = true;
    options.onResumeCheckpointed?.({
      canInterrupt: runIsActive && state.pendingHumanReview === null,
    });
  };
  const readResumeCheckpointAtBoundary = async () => {
    if (!isResumeRequest || !options.onResumeCheckpointed || resumeCheckpointed) return;
    try {
      confirmResumeCheckpoint(await graphService.readThreadState(setup), true);
    } catch {
      // Checkpoint confirmation is best-effort while the stream is active. A
      // failed read must not cancel an otherwise valid review resolution.
    }
  };
  let run: LocalAgentGraphEventStream | null = null;
  let finishInterruptedAfterSettlement = false;
  try {
    run = await graphService.streamEvents(setup, graphInput);
    const toolReader = new NamespacedProtocolToolEventReader();
    for await (const chatEvent of adaptRootStream(run as AsyncIterable<RootProtocolEvent>)) {
      if (chatEvent.type === 'values' || chatEvent.type === 'interrupt') {
        await readResumeCheckpointAtBoundary();
      }
      if (!isCurrent()) {
        finishInterruptedAfterSettlement = true;
        return { status: 'interrupted' };
      }

      switch (chatEvent.type) {
        case 'assistant.delta': {
          streamedReply += chatEvent.text;
          recordAgentRunActivity('streaming', requestId);
          emitEvent({
            type: 'message.delta',
            requestId,
            role: 'assistant',
            text: chatEvent.text,
          });
          break;
        }
        case 'subagent.message': {
          // One completed subagent message per child model lifecycle — the
          // ambient progress feed is block-level by design (see the adapter).
          emitEvent({
            type: 'subagent.message.completed',
            requestId,
            messageId: chatEvent.messageId,
            namespace: chatEvent.namespace,
            text: chatEvent.text,
          });
          break;
        }
        case 'tool': {
          const lifecycle = toolReader.readToolsData(chatEvent.namespace, chatEvent.data);
          if (lifecycle) {
            emitToolEvent(lifecycle as StreamToolsPayload);
          }
          break;
        }
        case 'runtime.custom': {
          if (chatEvent.name === SUBAGENT_OPERATIONS_EVENT) {
            const operations = readDelegationOperations(chatEvent.data);
            if (operations) {
              acceptDelegationOperations?.(operations);
            }
            break;
          }
          const notice = formatToolAuthorizationNotice(chatEvent.name, chatEvent.data);
          if (notice) {
            emitEvent({
              type: 'system.notice',
              requestId,
              message: notice,
            });
          }
          break;
        }
        case 'guard.decision':
          // Decision records are observability, not chat surface — parity
          // with the legacy path, which did not consume the custom mode.
          break;
        case 'values': {
          const messages = (chatEvent.values as { messages?: BaseMessage[] }).messages;
          if (Array.isArray(messages)) {
            finalMessages = messages;
          }
          break;
        }
        case 'interrupt': {
          const interruptPayload = readFirstHumanReviewInterrupt(chatEvent.interrupts);
          if (interruptPayload) {
            emitHumanReviewRequested({
              ...(interruptPayload.interruptId ? { interruptId: interruptPayload.interruptId } : {}),
              reviews: normalizeReviewList(interruptPayload.review, interruptPayload.reviews),
              requestId,
              emitEvent,
            });
            return { status: 'waiting_human' };
          }
          break;
        }
      }
    }
  } catch (error) {
    // The orchestrator graph's hard recursion breaker fired — the run did not
    // converge within its step budget. Degrade to the same graceful "待续跑"
    // outcome as the soft run-iteration guard instead of surfacing a raw
    // GraphRecursionError as a chat error. #275/P6.
    if (!isGraphRecursionLimitError(error)) {
      throw error;
    }
    if (!isCurrent()) {
      finishInterruptedAfterSettlement = true;
      return { status: 'interrupted' };
    }
    const reply = streamedReply.trim() || RECURSION_LIMIT_NOTICE;
    if (!streamedReply.trim()) {
      emitEvent({ type: 'message.delta', requestId, role: 'assistant', text: reply });
    }
    emitEvent({ type: 'message.completed', requestId, role: 'assistant', text: reply });
    clearAgentRunActivity(requestId);
    return { status: 'completed', reply };
  } finally {
    await waitForGraphRunSettlement(run);
    if (finishInterruptedAfterSettlement) {
      finishInterrupted();
    }
  }

  if (!isCurrent()) {
    finishInterrupted();
    return { status: 'interrupted' };
  }

  const finalThreadState = await graphService.readThreadState(setup);
  confirmResumeCheckpoint(
    finalThreadState,
    options.interruptOnSettledResumeCheckpoint === true,
  );
  if (!isCurrent()) {
    finishInterrupted();
    return { status: 'interrupted' };
  }

  if (finalThreadState.pendingHumanReview) {
    emitHumanReviewRequested({
      ...(finalThreadState.pendingHumanReview.interruptId
        ? { interruptId: finalThreadState.pendingHumanReview.interruptId }
        : {}),
      reviews: normalizeReviewList(
        finalThreadState.pendingHumanReview.review,
        finalThreadState.pendingHumanReview.reviews,
      ),
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

function readFirstHumanReviewInterrupt(
  interrupts: unknown[],
): { interruptId?: string; review: ReviewSpec; reviews: ReviewSpec[] } | null {
  const firstInterrupt = interrupts[0] ?? null;
  const interruptId = firstInterrupt
    && typeof firstInterrupt === 'object'
    && typeof (firstInterrupt as { id?: unknown }).id === 'string'
    ? (firstInterrupt as { id: string }).id
    : undefined;
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
  if (isHumanReviewBatchInterruptPayload(value)) {
    const reviews = value.reviews.map((item) => item.review);
    const review = reviews[0];
    if (!review) {
      return null;
    }
    return {
      ...(interruptId ? { interruptId } : {}),
      review,
      reviews,
    };
  }
  if (!isHumanReviewInterruptPayload(value)) {
    throwUnexpectedInterruptPayload();
  }
  return {
    ...(interruptId ? { interruptId } : {}),
    review: value.review,
    reviews: [value.review],
  };
}
