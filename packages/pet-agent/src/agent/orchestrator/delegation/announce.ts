import type { BaseMessage } from '@langchain/core/messages';
import type { SubagentCompletionReason } from '../../../types/subagent';
import {
  getAgentMessageDelegationId,
  getAgentMessageLane,
  getAgentMessageMetadata,
  getAgentMessageTranscriptRunId,
  isCapabilityMessageLane,
  queryAgentMessages,
  setAgentMessageMetadata,
  type DelegationMessageScope,
} from '../../messages';
import type { SubagentAnnounce } from '../types';
import { readMessageText } from '../utils';

export * from './announceMessage';

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

export type DelegationLaneAnnounceSelector = Partial<DelegationMessageScope> & {
  announceMessageId?: string | null;
};

function readTaggedAnnounce(message: BaseMessage): SubagentAnnounce | null {
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
  options: DelegationLaneAnnounceSelector,
): DelegationMessageScope | null {
  return options.lane && options.transcriptRunId && options.delegationId
    ? {
        lane: options.lane,
        transcriptRunId: options.transcriptRunId,
        delegationId: options.delegationId,
      }
    : null;
}

export function selectDelegationLaneAnnounceMessages(
  messages: readonly BaseMessage[],
  options: DelegationLaneAnnounceSelector = {},
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
      options.transcriptRunId
      && getAgentMessageTranscriptRunId(message) !== options.transcriptRunId
    ) return false;
    if (options.delegationId && announce.delegationId !== options.delegationId) return false;
    if (options.announceMessageId && announce.messageId !== options.announceMessageId) return false;
    return true;
  });
}

export function selectDelegationLaneAnnounceMessage(
  messages: readonly BaseMessage[],
  options: DelegationLaneAnnounceSelector = {},
): BaseMessage | null {
  return selectDelegationLaneAnnounceMessages(messages, options).at(-1) ?? null;
}

export function readLatestAnnounce(
  messages: readonly BaseMessage[],
  options: DelegationLaneAnnounceSelector = {},
): SubagentAnnounce | null {
  const message = selectDelegationLaneAnnounceMessage(messages, options);
  return message ? readTaggedAnnounce(message) : null;
}

export function readLatestAnnounceCompletionReason(
  messages: readonly BaseMessage[],
  options: DelegationLaneAnnounceSelector = {},
): SubagentCompletionReason | null {
  const message = selectDelegationLaneAnnounceMessage(messages, options);
  return message ? getMessageCompletionReason(message) : null;
}
