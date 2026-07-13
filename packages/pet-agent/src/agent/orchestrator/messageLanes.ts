import { AIMessage, RemoveMessage, type BaseMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';
import type { MessageLane, PinpetMessageLane, SubagentAnnounce, SubagentCompletionReason } from './types';
import type { CapabilityArtifactRef } from '../../types/artifact';
import { formatHandoffArtifactRefsForMessage } from './artifacts/handoff';
import { messageHasToolCalls, readMessageToolCallIds, readToolResultCallId } from '../../utils/messages';
import { readMessageText } from './utils';

export function getMessageLane(message: BaseMessage): PinpetMessageLane | null {
  const pinpawo = message.additional_kwargs?.pinpawo;
  if (!pinpawo || typeof pinpawo !== 'object' || !('lane' in pinpawo)) {
    return null;
  }
  const lane = pinpawo.lane;
  return typeof lane === 'string' ? lane as PinpetMessageLane : null;
}

export function getPinpetMeta(message: BaseMessage): Record<string, unknown> {
  const pinpawo = message.additional_kwargs?.pinpawo;
  return pinpawo && typeof pinpawo === 'object' ? pinpawo as Record<string, unknown> : {};
}

export function setPinpetMeta(message: BaseMessage, patch: Record<string, unknown>) {
  message.additional_kwargs = {
    ...message.additional_kwargs,
    pinpawo: { ...getPinpetMeta(message), ...patch },
  };
}

export function stampMessageCreatedAtUtc(
  message: BaseMessage,
  createdAt = new Date().toISOString(),
) {
  setPinpetMeta(message, { createdAt });
  return message;
}

export function readMessageCreatedAtUtc(message: BaseMessage): string | null {
  const createdAt = getPinpetMeta(message).createdAt;
  return typeof createdAt === 'string' && createdAt.trim() ? createdAt : null;
}

/**
 * Neutral marker for "this lane message carries the subagent's deliverable text".
 * Replaces the completed/progress announce tag: it says WHICH message is the
 * announce, without judging whether the task is complete (that judgment now lives
 * with the orchestrator / handoff). See docs/PET_AGENT_ANNOUNCE_JUDGMENT_REFACTOR.md.
 */
export function setMessageIsAnnounce(message: BaseMessage) {
  setPinpetMeta(message, { isAnnounce: true });
}

export function getMessageIsAnnounce(message: BaseMessage): boolean {
  return getPinpetMeta(message).isAnnounce === true;
}

export function getMessageCompletionReason(message: BaseMessage): SubagentCompletionReason | null {
  const completionReason = getPinpetMeta(message).completionReason;
  return typeof completionReason === 'string' ? completionReason as SubagentCompletionReason : null;
}

function ensureMessageId(message: BaseMessage): string {
  if (!message.id) {
    message.id = randomUUID();
  }
  return message.id;
}

export function getMessageDelegationId(message: BaseMessage): string | null {
  const delegationId = getPinpetMeta(message).delegationId;
  return typeof delegationId === 'string' ? delegationId : null;
}

export function getMessageDelegatedTask(message: BaseMessage): string | null {
  const task = getPinpetMeta(message).task;
  return typeof task === 'string' && task.trim() ? task.trim() : null;
}

export function getMessageTurnId(message: BaseMessage): string | null {
  const meta = getPinpetMeta(message);
  const runId = meta.runId;
  if (typeof runId === 'string') return runId;
  return null;
}

export function toolProtocolSafeMessages(messages: BaseMessage[]) {
  const safeMessages: BaseMessage[] = [];

  for (let i = 0; i < messages.length;) {
    const message = messages[i];
    const toolCallIds = readMessageToolCallIds(message);

    if (toolCallIds.length === 0) {
      if (message._getType() !== 'tool') {
        safeMessages.push(message);
      }
      i += 1;
      continue;
    }

    const followingToolMessages: BaseMessage[] = [];
    const answeredToolCallIds = new Set<string>();
    let nextIndex = i + 1;
    while (nextIndex < messages.length && messages[nextIndex]._getType() === 'tool') {
      const toolMessage = messages[nextIndex];
      followingToolMessages.push(toolMessage);
      const toolCallId = readToolResultCallId(toolMessage);
      if (toolCallId) {
        answeredToolCallIds.add(toolCallId);
      }
      nextIndex += 1;
    }

    const allToolCallsAnswered = toolCallIds.every((toolCallId) => answeredToolCallIds.has(toolCallId));
    if (allToolCallsAnswered) {
      safeMessages.push(message, ...followingToolMessages);
    }

    i = nextIndex;
  }

  return safeMessages;
}

/**
 * Filter messages by lane + runId + delegationId.
 * Subagent sees: unlaned messages + messages from its own delegation only.
 * A continued delegation (limit_reached -> resume) reuses its delegationId, so it
 * carries its own transcript back; a new task in the same lane gets a fresh
 * delegationId and starts clean — conclusions cross task boundaries via
 * runDelegationSummaries/announces, transcripts don't.
 * Lane messages without a delegationId (legacy checkpoints) are excluded.
 * For orchestration decisions, use mainConversationMessages() instead.
 */
export function laneMessages(
  messages: BaseMessage[],
  lane: MessageLane,
  runId: string,
  delegationId: string,
) {
  return toolProtocolSafeMessages(messages.filter((message) => {
    const messageLane = getMessageLane(message);
    if (!messageLane) return true;
    return messageLane === lane
      && getMessageTurnId(message) === runId
      && getMessageDelegationId(message) === delegationId;
  }));
}

/**
 * Build message list for orchestration decision nodes.
 * Decision nodes see the user-facing conversation only. Subagent announce history
 * is recalled separately from lane-tagged messages.
 */
export function mainConversationMessages(messages: BaseMessage[]): BaseMessage[] {
  return messages.filter((message) => !getMessageLane(message));
}

export const routeMessages = mainConversationMessages;


/**
 * Tag new messages from a subagent result: stamp lane/runId/delegationId on each,
 * and mark which message is the announce (the deliverable text). It does NOT judge
 * completed/progress — that judgment is the orchestrator's (see handoff). The
 * completionReason is attached to the announce message as a stop-reason hint for
 * the decision node.
 *
 * Announce selection: prefer the last tool-call-free AI message with text (the
 * natural deliverable). As a defensive fallback, allow the last AI/tool message
 * with text as a best-effort deliverable; for limit_reached runs we avoid tool
 * fallback because interrupted tool output is more likely to be protocol noise.
 */
export function tagNewLaneMessages(
  messages: BaseMessage[],
  existingCount: number,
  lane: MessageLane,
  runId: string,
  completionReason: SubagentCompletionReason,
  reportMeta?: {
    delegationId?: string | null;
    task?: string | null;
  },
) {
  const nextMessages = messages.slice(existingCount);
  for (const message of nextMessages) {
    if (message._getType() === 'human') continue;
    ensureMessageId(message);
    setPinpetMeta(message, { lane, runId, delegationId: reportMeta?.delegationId ?? null });
  }

  // Find the announce message: prefer the last tool-call-free AI message with
  // text; fall back to the last AI/tool message with text.
  let announceIndex = -1;
  for (let i = nextMessages.length - 1; i >= 0; i--) {
    if (
      nextMessages[i]._getType() === 'ai'
      && !messageHasToolCalls(nextMessages[i])
      && readMessageText(nextMessages[i])
    ) {
      announceIndex = i;
      break;
    }
  }
  const allowFallbackToRawMessage = completionReason !== 'limit_reached';
  if (announceIndex < 0 && allowFallbackToRawMessage) {
    for (let i = nextMessages.length - 1; i >= 0; i--) {
      const type = nextMessages[i]._getType();
      if (
        (type === 'ai' || type === 'tool')
        && !messageHasToolCalls(nextMessages[i])
        && readMessageText(nextMessages[i])
      ) {
        announceIndex = i;
        break;
      }
    }
  }

  if (announceIndex >= 0) {
    setMessageIsAnnounce(nextMessages[announceIndex]);
    setPinpetMeta(nextMessages[announceIndex], {
      delegationId: reportMeta?.delegationId ?? null,
      task: reportMeta?.task ?? null,
      completionReason,
    });
  }

  return toolProtocolSafeMessages(nextMessages);
}

/**
 * Source metadata stamped on a handed-off announce copy in the main queue.
 * Minimal set: which executor/capability delivered it, for which delegation/task.
 */
export type HandoffSource = {
  handoffFrom: MessageLane;
  delegationId: string;
  runId: string;
  task: string | null;
};

export function getMessageHandoffSource(message: BaseMessage): HandoffSource | null {
  const meta = getPinpetMeta(message);
  const handoffFrom = meta.handoffFrom;
  if (typeof handoffFrom !== 'string') return null;
  return {
    handoffFrom: handoffFrom as MessageLane,
    delegationId: typeof meta.delegationId === 'string' ? meta.delegationId : '',
    runId: typeof meta.runId === 'string' ? meta.runId : '',
    task: typeof meta.task === 'string' ? meta.task : null,
  };
}

/**
 * Build the state-message update for handing a completed subagent delegation
 * back to the main conversation queue.
 *
 * This replaces laneMessagesForStateUpdate's "prune in place" approach: instead
 * of leaving the lane-tagged announce mixed into main, we COPY the announce text
 * into a fresh main-queue message (a first-class main message, not lane-tagged)
 * and WIPE the entire delegation's lane (original announce + intermediate
 * transcript). See docs/PET_AGENT_ANNOUNCE_JUDGMENT_REFACTOR.md.
 *
 * Returns the messages array update: optionally removes lane messages for this
 * lane+runId+delegationId, followed by the main-queue copy.
 * Returns null (no update) when no announce text can be located for the
 * delegation — caller should fall back to leaving state untouched.
 */
export function buildSubagentHandoff(params: {
  messages: BaseMessage[];
  lane: MessageLane;
  runId: string;
  delegationId: string;
  clearLane?: boolean;
  includeCopy?: boolean;
  artifactRefs?: Pick<
    CapabilityArtifactRef,
    'id' | 'kind' | 'mimeType' | 'uri' | 'title' | 'preview' | 'capabilityId' | 'delegationId' | 'runId'
  >[];
}): BaseMessage[] | null {
  const announceMessage = readLatestAnnounceMessage(params.messages, {
    runId: params.runId,
    delegationId: params.delegationId,
  });
  const announceText = announceMessage ? readMessageText(announceMessage) : '';
  if (!announceText.trim()) return null;

  const task = announceMessage ? getMessageDelegatedTask(announceMessage) : null;
  const artifactRefFooter = params.artifactRefs && params.artifactRefs.length > 0
    ? formatHandoffArtifactRefsForMessage(params.artifactRefs.map((ref) => ({
      ...ref,
      delegationId: params.delegationId,
      runId: params.runId,
    })))
    : '';

  const clearLane = params.clearLane ?? true;
  const includeCopy = params.includeCopy ?? true;
  const removeMessages = clearLane
    ? params.messages.flatMap((message) => {
      if (getMessageLane(message) !== params.lane) return [];
      if (getMessageTurnId(message) !== params.runId) return [];
      if (getMessageDelegationId(message) !== params.delegationId) return [];
      // Legacy checkpointed lane messages may predate message ids; LangGraph
      // RemoveMessage cannot target them, so those old messages are left as
      // residual history instead of risking an invalid delete.
      if (!message.id) return [];
      return [new RemoveMessage({ id: message.id }) as BaseMessage];
    })
    : [];

  if (!includeCopy) {
    return removeMessages;
  }

  // The copy is a first-class main message (no lane), carrying only minimal
  // provenance so the main agent knows which executor produced it for which task.
  const handoffCopy = new AIMessage(`${announceText}${artifactRefFooter}`);
  stampMessageCreatedAtUtc(handoffCopy);
  setPinpetMeta(handoffCopy, {
    handoffFrom: params.lane,
    delegationId: params.delegationId,
    runId: params.runId,
    task,
  });

  return [
    ...removeMessages,
    handoffCopy,
  ];
}

export function readLatestHumanRequest(messages: BaseMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message._getType() !== 'human') continue;
    const text = readMessageText(message);
    if (text) return text;
  }
  return null;
}

function isDelegationLane(messageLane: PinpetMessageLane | null): messageLane is MessageLane {
  return messageLane === 'general' || Boolean(messageLane?.startsWith('capability:'));
}

function readTaggedAnnounce(message: BaseMessage): SubagentAnnounce | null {
  if (!getMessageIsAnnounce(message)) return null;
  const lane = getMessageLane(message);
  if (!isDelegationLane(lane)) return null;
  return {
    lane,
    delegationId: getMessageDelegationId(message),
    task: getMessageDelegatedTask(message),
    text: readMessageText(message) || null,
  };
}

function readLatestAnnounceMessage(
  messages: BaseMessage[],
  options: { runId?: string | null; delegationId?: string | null } = {},
): BaseMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const runId = options.runId;
    if (runId && getMessageTurnId(message) !== runId) continue;
    if (options.delegationId && getMessageDelegationId(message) !== options.delegationId) continue;
    if (readTaggedAnnounce(message)) return message;
  }
  return null;
}

export function readLatestAnnounce(
  messages: BaseMessage[],
  options: { runId?: string | null; delegationId?: string | null } = {},
): SubagentAnnounce | null {
  const message = readLatestAnnounceMessage(messages, options);
  return message ? readTaggedAnnounce(message) : null;
}

export function readLatestAnnounceCompletionReason(
  messages: BaseMessage[],
  options: { runId?: string | null; delegationId?: string | null } = {},
): SubagentCompletionReason | null {
  const message = readLatestAnnounceMessage(messages, options);
  return message ? getMessageCompletionReason(message) : null;
}
