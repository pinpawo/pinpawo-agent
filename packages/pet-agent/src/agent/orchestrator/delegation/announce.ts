import type { BaseMessage } from '@langchain/core/messages';
import type { SubagentCompletionReason } from '../../../types/subagent';
import {
  getAgentMessageDelegationId,
  getAgentMessageLane,
  getAgentMessageMetadata,
  getAgentMessageRunId,
  isCapabilityMessageLane,
  queryAgentMessages,
  setAgentMessageMetadata,
  type CapabilityMessageLane,
  type DelegationMessageScope,
} from '../../messages';
import { readMessageText } from '../utils';

export * from './announceMessage';

export type DelegationAnnounce = {
  messageId: string | null;
  lane: CapabilityMessageLane;
  delegationId: string | null;
  task: string | null;
  text: string | null;
};

export function setMessageIsAnnounce(message: BaseMessage) {
  setAgentMessageMetadata(message, { isAnnounce: true });
}

export function getMessageIsAnnounce(message: BaseMessage): boolean {
  return getAgentMessageMetadata(message).isAnnounce === true;
}

export function getMessageCompletionReason(
  message: BaseMessage,
): SubagentCompletionReason | null {
  const completionReason = getAgentMessageMetadata(message).completionReason;
  return typeof completionReason === 'string'
    ? completionReason as SubagentCompletionReason
    : null;
}

export function getMessageDelegatedTask(message: BaseMessage): string | null {
  const task = getAgentMessageMetadata(message).task;
  return typeof task === 'string' && task.trim() ? task.trim() : null;
}

export type DelegationAnnounceSelector = Partial<DelegationMessageScope> & {
  announceMessageId?: string | null;
};

function readTaggedAnnounce(message: BaseMessage): DelegationAnnounce | null {
  if (!getMessageIsAnnounce(message)) return null;
  const lane = getAgentMessageLane(message);
  if (!isCapabilityMessageLane(lane)) return null;
  return {
    messageId: message.id ?? null,
    lane,
    delegationId: getAgentMessageDelegationId(message),
    task: getMessageDelegatedTask(message),
    text: readMessageText(message) || null,
  };
}

function completeSelectorScope(
  options: DelegationAnnounceSelector,
): DelegationMessageScope | null {
  return options.lane && options.runId && options.delegationId
    ? {
        lane: options.lane,
        runId: options.runId,
        delegationId: options.delegationId,
      }
    : null;
}

export function selectDelegationAnnounceMessages(
  messages: readonly BaseMessage[],
  options: DelegationAnnounceSelector = {},
): BaseMessage[] {
  const scope = completeSelectorScope(options);
  const candidates = scope
    ? queryAgentMessages(messages).delegation(scope).select().messages
    : messages;
  return candidates.filter((message) => {
    const announce = readTaggedAnnounce(message);
    if (!announce) return false;
    if (options.lane && announce.lane !== options.lane) return false;
    if (
      options.runId
      && getAgentMessageRunId(message) !== options.runId
    ) return false;
    if (options.delegationId && announce.delegationId !== options.delegationId) return false;
    if (options.announceMessageId && announce.messageId !== options.announceMessageId) return false;
    return true;
  });
}

export function selectDelegationAnnounceMessage(
  messages: readonly BaseMessage[],
  options: DelegationAnnounceSelector = {},
): BaseMessage | null {
  return selectDelegationAnnounceMessages(messages, options).at(-1) ?? null;
}

export function readLatestAnnounce(
  messages: readonly BaseMessage[],
  options: DelegationAnnounceSelector = {},
): DelegationAnnounce | null {
  const message = selectDelegationAnnounceMessage(messages, options);
  return message ? readTaggedAnnounce(message) : null;
}

export function readLatestAnnounceCompletionReason(
  messages: readonly BaseMessage[],
  options: DelegationAnnounceSelector = {},
): SubagentCompletionReason | null {
  const message = selectDelegationAnnounceMessage(messages, options);
  return message ? getMessageCompletionReason(message) : null;
}
