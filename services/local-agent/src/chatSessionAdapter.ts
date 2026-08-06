import type { BaseMessage } from '@langchain/core/messages';
import {
  createTokenUsageSnapshot,
  GLOBAL_REVIEW_POLICY_RUNTIME_EVENT,
  isGraphRecursionLimitError,
  isHumanReviewBatchInterruptPayload,
  isHumanReviewInterruptPayload,
  NamespacedProtocolToolEventReader,
  projectHumanReviewRequest,
  readLatestProviderInputTokens,
  readMessagesTokenUsage,
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
import type {
  AgentPlan,
  AgentLocalAttachment,
  AgentRuntimeEvent,
} from '@pinpawo/agent-session';
import {
  readFinalMessageText,
  type StreamToolsPayload,
} from './agentStreamEvents';
import {
  adaptRootStream,
  type RootProtocolEvent,
} from './events/rootStreamEventAdapter';
import { clearAgentRunActivity, recordAgentRunActivity } from './operationActivityState';
import { createLocalChatHumanMessage } from './localChatAttachments';
import {
  currentPlansEqual,
  projectCurrentPlan,
} from './currentPlanProjection';

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
      attachments?: AgentLocalAttachment[];
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
  /** Registers an ephemeral route to the authoritative specs used for resume validation. */
  registerHumanReviewResolutionRoute?: (params: {
    requestId: string;
    interruptId?: string;
    reviews: ReviewSpec[];
  }) => void;
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
  /**
   * Host admission hook for durable local attachments. It runs only after
   * pending-review checks and before graph invocation.
   */
  prepareUserMessage?: () => Promise<BaseMessage>;
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
  registerHumanReviewResolutionRoute?: ChatSessionAdapterOptions['registerHumanReviewResolutionRoute'];
}) {
  const review = params.reviews[0];
  if (!review) {
    return;
  }
  const reviews = params.reviews;
  recordAgentRunActivity('waiting_human', params.requestId);
  params.registerHumanReviewResolutionRoute?.({
    requestId: params.requestId,
    ...(params.interruptId ? { interruptId: params.interruptId } : {}),
    reviews,
  });
  params.emitEvent({
    type: 'human_review.requested',
    requestId: params.requestId,
    ...(params.interruptId ? { interruptId: params.interruptId } : {}),
    review: projectHumanReviewRequest(review),
    ...(reviews.length > 1 ? { reviews: reviews.map(projectHumanReviewRequest) } : {}),
  });
}

function readCustomEventData(data: unknown): Record<string, unknown> | null {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : null;
}

function readDisplayText(value: unknown, maxLength = 500): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
}

function readAuthorizedToolLabels(data: Record<string, unknown> | null) {
  const toolCalls = Array.isArray(data?.toolCalls) ? data.toolCalls : [];
  const toolLabels = toolCalls.flatMap((toolCall) => {
    const entry = readCustomEventData(toolCall);
    const toolName = readDisplayText(entry?.toolName, 80);
    if (!toolName) return [];
    const toolkitName = readDisplayText(entry?.toolkitName, 80);
    return [toolkitName ? `${toolkitName} · ${toolName}` : toolName];
  });
  if (toolLabels.length > 0) return [...new Set(toolLabels)].slice(0, 6);
  const toolName = readDisplayText(data?.toolName, 80);
  return toolName ? [toolName] : [];
}

function projectGlobalPolicyAuthorization(
  name: string,
  rawData: unknown,
  requestId: string,
  streamSequence: number,
): Extract<AgentRuntimeEvent, { type: 'operation' }> | null {
  const isAuto = name === GLOBAL_REVIEW_POLICY_RUNTIME_EVENT.AUTO_AUTHORIZED;
  const isCustomPolicy = name === GLOBAL_REVIEW_POLICY_RUNTIME_EVENT.CUSTOM_AUTHORIZED;
  if (!isAuto && !isCustomPolicy) return null;

  const data = readCustomEventData(rawData);
  const toolLabels = readAuthorizedToolLabels(data);
  const reason = readDisplayText(data?.reason);
  const reportedBatchSize = typeof data?.batchSize === 'number'
    && Number.isInteger(data.batchSize)
    && data.batchSize > 0
    ? data.batchSize
    : null;
  const batchSize = reportedBatchSize ?? Math.max(1, toolLabels.length);
  const label = isAuto ? '自动授权' : '按策略授权';

  return {
    type: 'operation',
    requestId,
    phase: 'completed',
    operation: {
      id: `authorization:${name}:${streamSequence}`,
      kind: 'runtime.authorization',
      title: batchSize > 1 ? `${label} · ${batchSize} 项操作` : label,
      ...(toolLabels.length > 0 ? { summary: toolLabels.join(' · ') } : {}),
      ...((toolLabels.length > 0 || reason)
        ? {
            details: {
              ...(toolLabels.length > 0 ? { toolLabels } : {}),
              ...(reason ? { reason } : {}),
            },
          }
        : {}),
      source: {
        provider: 'runtime',
        name: 'global_review_policy',
      },
    },
  };
}

/** Keep human-recorded session authorization as a compact notice. */
function formatToolAuthorizationNotice(name: string, rawData: unknown): string | null {
  if (name !== 'tool_authorization_recorded') {
    return null;
  }
  const data = readCustomEventData(rawData);
  if (data?.source === 'auto_review') {
    return null;
  }
  const toolName = typeof data?.toolName === 'string' && data.toolName.trim()
    ? data.toolName
    : null;
  return toolName
    ? `已授权当前会话中的 ${toolName} 操作。`
    : '已授权当前会话中的工具操作。';
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
  const attachments = request.kind === 'user_message'
    ? request.attachments ?? []
    : [];

  const initialThreadState = await graphService.readThreadState(setup);
  if (!isCurrent()) {
    finishInterrupted();
    return { status: 'interrupted' };
  }

  if (initialThreadState.pendingHumanReview && !isResumeRequest) {
    if (message.trim() || attachments.length > 0) {
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
      registerHumanReviewResolutionRoute: options.registerHumanReviewResolutionRoute,
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
    const userMessage = options.prepareUserMessage
      ? await options.prepareUserMessage()
      : createLocalChatHumanMessage(message, attachments);
    setup.input.messages = [
      ...setup.input.messages.slice(0, -1),
      userMessage,
    ];
  }

  let finalMessages: BaseMessage[] = [];
  let streamedReply = '';
  let emittedPlan: AgentPlan | null = null;
  const emitCurrentPlan = (plan: AgentPlan | null) => {
    if (currentPlansEqual(emittedPlan, plan)) return;
    emittedPlan = plan;
    emitEvent({
      type: 'plan.updated',
      requestId,
      plan,
    });
  };
  emitCurrentPlan(initialThreadState.currentPlan ?? null);
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
          const authorization = projectGlobalPolicyAuthorization(
            chatEvent.name,
            chatEvent.data,
            requestId,
            chatEvent.streamSequence,
          );
          if (authorization) {
            emitEvent(authorization);
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
          emitCurrentPlan(projectCurrentPlan(chatEvent.values));
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
  emitCurrentPlan(finalThreadState.currentPlan ?? null);
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
      registerHumanReviewResolutionRoute: options.registerHumanReviewResolutionRoute,
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
