import { AIMessage, RemoveMessage, type BaseMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';
import type { AnnounceKind, MessageLane, PinpetMessageLane, SubagentAnnounce, SubagentCompletionReason } from './types';
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

export function getMessageAnnounce(message: BaseMessage): AnnounceKind | null {
  const announce = getPinpetMeta(message).announce;
  return announce === 'completed' || announce === 'progress' ? announce : null;
}

export function getMessageCompletionReason(message: BaseMessage): SubagentCompletionReason | null {
  const completionReason = getPinpetMeta(message).completionReason;
  return typeof completionReason === 'string' ? completionReason as SubagentCompletionReason : null;
}

export function setMessageAnnounce(message: BaseMessage, kind: AnnounceKind) {
  setPinpetMeta(message, { announce: kind });
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
  const turnId = getPinpetMeta(message).turnId;
  return typeof turnId === 'string' ? turnId : null;
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
 * Filter messages by lane + turnId + delegationId.
 * Subagent sees: unlaned messages + messages from its own delegation only.
 * A continued delegation (limit_reached -> resume) reuses its delegationId, so it
 * carries its own transcript back; a new task in the same lane gets a fresh
 * delegationId and starts clean — conclusions cross task boundaries via
 * turnDelegations/announces, transcripts don't.
 * Lane messages without a delegationId (legacy checkpoints) are excluded.
 * For orchestration decisions, use mainConversationMessages() instead.
 */
export function laneMessages(
  messages: BaseMessage[],
  lane: MessageLane,
  turnId: string,
  delegationId: string,
) {
  return toolProtocolSafeMessages(messages.filter((message) => {
    const messageLane = getMessageLane(message);
    if (!messageLane) return true;
    return messageLane === lane
      && getMessageTurnId(message) === turnId
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
 * Build the message list for the final answer node.
 *
 * Unlike decision nodes (which see the user-facing conversation only), the
 * answer node must reproduce prior subagent results faithfully. The completed
 * announce is the authoritative copy of a subagent's result that the lane
 * cleanup deliberately preserves (laneMessagesForStateUpdate removes the
 * intermediate transcript and keeps only the completed announce), so we keep it
 * in place rather than filtering it out and re-injecting a digest.
 *
 * Kept: unlaned main-conversation messages + every announce (completed AND
 * progress), in their original order. Dropped: intermediate lane transcripts and
 * orchestrator-internal lane messages (e.g. capability_search calls) — i.e. lane
 * messages without an announce tag.
 *
 * Progress announces are kept so that, after a limit_reached/progress turn, a
 * user asking "how far did it get?" still reaches the answer node with the
 * progress content (the decision view surfaces these via recent announces, so
 * the answer view must not be blind to them). The intermediate transcript that
 * is not yet cleaned up for an in-progress lane is still dropped here.
 *
 * Announce messages never carry tool calls (tagNewLaneMessages only marks a
 * tool-call-free AI/tool message as an announce). A progress announce can be a
 * tool message, though, and we drop the intermediate transcript it depended on,
 * so the result is run through toolProtocolSafeMessages to drop any orphaned
 * tool message rather than sending an invalid tool-result without its call.
 */
export function answerConversationMessages(messages: BaseMessage[]): BaseMessage[] {
  return toolProtocolSafeMessages(messages.filter((message) => {
    if (!getMessageLane(message)) return true;
    return getMessageAnnounce(message) !== null;
  }));
}

/**
 * Tag new messages from subagent result and select an announce message.
 *
 * Announce kind is determined by completionReason + message content:
 * - natural + last AI with text -> completed
 * - otherwise, last AI/tool with text -> progress
 */
export function tagNewLaneMessages(
  messages: BaseMessage[],
  existingCount: number,
  lane: MessageLane,
  turnId: string,
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
    setPinpetMeta(message, { lane, turnId, delegationId: reportMeta?.delegationId ?? null });
  }

  // Find the last AI message with text content.
  let lastAiIndex = -1;
  for (let i = nextMessages.length - 1; i >= 0; i--) {
    if (
      nextMessages[i]._getType() === 'ai'
      && !messageHasToolCalls(nextMessages[i])
      && readMessageText(nextMessages[i])
    ) {
      lastAiIndex = i;
      break;
    }
  }

  if (lastAiIndex >= 0 && completionReason === 'natural') {
    setMessageAnnounce(nextMessages[lastAiIndex], 'completed');
    setPinpetMeta(nextMessages[lastAiIndex], {
      delegationId: reportMeta?.delegationId ?? null,
      task: reportMeta?.task ?? null,
      completionReason,
    });
  } else {
    for (let i = nextMessages.length - 1; i >= 0; i--) {
      const type = nextMessages[i]._getType();
      if (
        (type === 'ai' || type === 'tool')
        && !messageHasToolCalls(nextMessages[i])
        && readMessageText(nextMessages[i])
      ) {
        setMessageAnnounce(nextMessages[i], 'progress');
        setPinpetMeta(nextMessages[i], {
          delegationId: reportMeta?.delegationId ?? null,
          task: reportMeta?.task ?? null,
          completionReason,
        });
        break;
      }
    }
  }

  return toolProtocolSafeMessages(nextMessages);
}

export function laneMessagesForStateUpdate(params: {
  existingMessages: BaseMessage[];
  outputMessages: BaseMessage[];
  lane: MessageLane;
  turnId: string;
  delegationId: string;
}): BaseMessage[] {
  const completedAnnounce = readLatestAnnounceMessage(params.outputMessages, {
    turnId: params.turnId,
    delegationId: params.delegationId,
  });
  if (!completedAnnounce || getMessageAnnounce(completedAnnounce) !== 'completed') {
    return params.outputMessages;
  }

  const announceId = ensureMessageId(completedAnnounce);
  const removeMessages = params.existingMessages.flatMap((message) => {
    if (getMessageLane(message) !== params.lane) return [];
    if (getMessageTurnId(message) !== params.turnId) return [];
    if (getMessageDelegationId(message) !== params.delegationId) return [];
    // Legacy checkpointed lane messages may predate message ids; LangGraph
    // RemoveMessage cannot target them, so those old messages are accepted as
    // residual history instead of risking an invalid delete.
    if (!message.id || message.id === announceId) return [];
    return [new RemoveMessage({ id: message.id }) as BaseMessage];
  });

  return [
    ...removeMessages,
    completedAnnounce,
  ];
}

/**
 * Source metadata stamped on a handed-off announce copy in the main queue.
 * Minimal set: which executor/capability delivered it, for which delegation/task.
 */
export type HandoffSource = {
  handoffFrom: MessageLane;
  delegationId: string;
  task: string | null;
};

export function getMessageHandoffSource(message: BaseMessage): HandoffSource | null {
  const meta = getPinpetMeta(message);
  const handoffFrom = meta.handoffFrom;
  if (typeof handoffFrom !== 'string') return null;
  return {
    handoffFrom: handoffFrom as MessageLane,
    delegationId: typeof meta.delegationId === 'string' ? meta.delegationId : '',
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
 * Returns the messages array update: RemoveMessage entries for every lane
 * message of this lane+turnId+delegationId, followed by the main-queue copy.
 * Returns null (no update) when no announce text can be located for the
 * delegation — caller should fall back to leaving state untouched.
 */
export function buildSubagentHandoff(params: {
  messages: BaseMessage[];
  lane: MessageLane;
  turnId: string;
  delegationId: string;
}): BaseMessage[] | null {
  const announceMessage = readLatestAnnounceMessage(params.messages, {
    turnId: params.turnId,
    delegationId: params.delegationId,
  });
  const announceText = announceMessage ? readMessageText(announceMessage) : '';
  if (!announceText.trim()) return null;

  const task = announceMessage ? getMessageDelegatedTask(announceMessage) : null;

  const removeMessages = params.messages.flatMap((message) => {
    if (getMessageLane(message) !== params.lane) return [];
    if (getMessageTurnId(message) !== params.turnId) return [];
    if (getMessageDelegationId(message) !== params.delegationId) return [];
    // Legacy checkpointed lane messages may predate message ids; LangGraph
    // RemoveMessage cannot target them, so those old messages are left as
    // residual history instead of risking an invalid delete.
    if (!message.id) return [];
    return [new RemoveMessage({ id: message.id }) as BaseMessage];
  });

  // The copy is a first-class main message (no lane), carrying only minimal
  // provenance so the main agent knows which executor produced it for which task.
  const handoffCopy = new AIMessage(announceText);
  setPinpetMeta(handoffCopy, {
    handoffFrom: params.lane,
    delegationId: params.delegationId,
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
  const kind = getMessageAnnounce(message);
  if (!kind) return null;
  const lane = getMessageLane(message);
  if (!isDelegationLane(lane)) return null;
  return {
    lane,
    delegationId: getMessageDelegationId(message),
    task: getMessageDelegatedTask(message),
    announce: kind,
    text: readMessageText(message) || null,
  };
}

function readLatestAnnounceMessage(
  messages: BaseMessage[],
  options: { turnId?: string | null; delegationId?: string | null } = {},
): BaseMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (options.turnId && getMessageTurnId(message) !== options.turnId) continue;
    if (options.delegationId && getMessageDelegationId(message) !== options.delegationId) continue;
    if (readTaggedAnnounce(message)) return message;
  }
  return null;
}

export function readLatestAnnounce(
  messages: BaseMessage[],
  options: { turnId?: string | null; delegationId?: string | null } = {},
): SubagentAnnounce | null {
  const message = readLatestAnnounceMessage(messages, options);
  return message ? readTaggedAnnounce(message) : null;
}

export function readLatestAnnounceCompletionReason(
  messages: BaseMessage[],
  options: { turnId?: string | null; delegationId?: string | null } = {},
): SubagentCompletionReason | null {
  const message = readLatestAnnounceMessage(messages, options);
  return message ? getMessageCompletionReason(message) : null;
}

export function readRecentAnnounces(messages: BaseMessage[], limit = 5): SubagentAnnounce[] {
  const announces: SubagentAnnounce[] = [];
  const seen = new Set<string>();

  for (let i = messages.length - 1; i >= 0 && announces.length < limit; i--) {
    const message = messages[i];
    const announce = readTaggedAnnounce(message);
    if (!announce) continue;
    const key = announce.delegationId
      ?? `${announce.lane}:${getMessageTurnId(message) ?? 'unknown'}:${i}`;
    if (seen.has(key)) continue;
    seen.add(key);
    announces.push(announce);
  }

  return announces.reverse();
}
