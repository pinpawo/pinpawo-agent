import type { BaseMessage } from '@langchain/core/messages';
import type { AnnounceKind, MessageLane, PinpetMessageLane, SubagentAnnounce, SubagentCompletionReason } from './types';
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

export function setMessageAnnounce(message: BaseMessage, kind: AnnounceKind) {
  setPinpetMeta(message, { announce: kind });
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

function readToolCallIds(message: BaseMessage): string[] {
  const record = message as BaseMessage & {
    tool_calls?: unknown;
    additional_kwargs?: { tool_calls?: unknown };
  };
  const toolCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls
    : Array.isArray(record.additional_kwargs?.tool_calls)
      ? record.additional_kwargs.tool_calls
      : [];

  return toolCalls.flatMap((call) => {
    if (!call || typeof call !== 'object') return [];
    const id = (call as Record<string, unknown>).id;
    return typeof id === 'string' && id ? [id] : [];
  });
}

function getToolMessageCallId(message: BaseMessage): string | null {
  if (message._getType() !== 'tool') return null;
  const toolCallId = (message as BaseMessage & { tool_call_id?: unknown }).tool_call_id;
  return typeof toolCallId === 'string' && toolCallId ? toolCallId : null;
}

function messageHasToolCalls(message: BaseMessage) {
  return readToolCallIds(message).length > 0;
}

export function toolProtocolSafeMessages(messages: BaseMessage[]) {
  const safeMessages: BaseMessage[] = [];

  for (let i = 0; i < messages.length;) {
    const message = messages[i];
    const toolCallIds = readToolCallIds(message);

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
      const toolCallId = getToolMessageCallId(toolMessage);
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
 * Filter messages by lane + turnId.
 * Subagent sees: unlaned messages + messages matching both lane and turnId.
 * For orchestration decisions, use mainConversationMessages() instead.
 */
export function laneMessages(messages: BaseMessage[], lane: MessageLane, turnId: string) {
  return toolProtocolSafeMessages(messages.filter((message) => {
    const messageLane = getMessageLane(message);
    if (!messageLane) return true;
    return messageLane === lane && getMessageTurnId(message) === turnId;
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
 * Tag new messages from subagent result and select an announce message.
 *
 * Announce kind is determined by completionReason + last message type:
 * - natural + last AI with text -> completed
 * - limit_reached or last message is tool result -> progress
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
    setPinpetMeta(message, { lane, turnId });
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
        });
        break;
      }
    }
  }

  return toolProtocolSafeMessages(nextMessages);
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

export function readLatestAnnounce(
  messages: BaseMessage[],
  options: { turnId?: string | null; delegationId?: string | null } = {},
): SubagentAnnounce | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (options.turnId && getMessageTurnId(message) !== options.turnId) continue;
    if (options.delegationId && getMessageDelegationId(message) !== options.delegationId) continue;
    const announce = readTaggedAnnounce(message);
    if (announce) return announce;
  }
  return null;
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
