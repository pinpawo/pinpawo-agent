import { RemoveMessage, type BaseMessage } from '@langchain/core/messages';
import type { SubagentCompletionReason } from '../../types/subagent';
import {
  delegationAnnounceMessages,
  getAgentMessageDelegationId,
  getAgentMessageLane,
  getAgentMessageMetadata,
  getAgentMessageTranscriptRunId,
  isCapabilityMessageLane,
  isMessageInDelegationScope,
  readAgentMessageCreatedAt,
  reconcileDelegationMessages,
  setAgentMessageMetadata,
  type CapabilityMessageLane,
  type DelegationMessageScope,
} from '../messages';
import { DelegationAnnounceMessage, getDelegationAnnounce } from './delegationAnnounce';
import type { SubagentAnnounce } from './types';
import { readMessageText } from './utils';

export function setMessageIsAnnounce(message: BaseMessage) {
  setAgentMessageMetadata(message, { isAnnounce: true });
}

export function getMessageIsAnnounce(message: BaseMessage): boolean {
  return getAgentMessageMetadata(message).isAnnounce === true;
}

export function getMessageCompletionReason(message: BaseMessage): SubagentCompletionReason | null {
  const completionReason = getAgentMessageMetadata(message).completionReason;
  return typeof completionReason === 'string'
    ? completionReason as SubagentCompletionReason
    : null;
}

export function getMessageDelegatedTask(message: BaseMessage): string | null {
  const task = getAgentMessageMetadata(message).task;
  return typeof task === 'string' && task.trim() ? task.trim() : null;
}

export function tagNewLaneMessages(
  messages: BaseMessage[],
  existingMessages: BaseMessage[],
  lane: CapabilityMessageLane,
  transcriptRunId: string,
  completionReason: SubagentCompletionReason,
  reportMeta: {
    delegationId?: string | null;
    task?: string | null;
    announceMessageId?: string | null;
  } = {},
  persistedInputMessages: BaseMessage[] = existingMessages,
) {
  const delegationId = reportMeta.delegationId?.trim();
  if (!delegationId) {
    throw new Error('Delegation transcript reconciliation requires delegationId.');
  }
  const scope: DelegationMessageScope = { lane, transcriptRunId, delegationId };
  const reconciled = reconcileDelegationMessages({
    resultMessages: messages,
    inputMessages: existingMessages,
    persistedInputMessages,
    scope,
  });
  const announceMessage = reportMeta.announceMessageId
    ? reconciled.added.find((message) => message.id === reportMeta.announceMessageId)
    : null;
  if (announceMessage) {
    setMessageIsAnnounce(announceMessage);
    setAgentMessageMetadata(announceMessage, {
      task: reportMeta.task ?? null,
      completionReason,
    });
  }
  return [...reconciled.removed, ...reconciled.added];
}

export type HandoffSource = {
  handoffFrom: CapabilityMessageLane;
  delegationId: string;
  runId: string;
  task: string | null;
  announceMessageId: string;
};

export function getMessageHandoffSource(message: BaseMessage): HandoffSource | null {
  const announce = getDelegationAnnounce(message);
  if (!announce) return null;
  return {
    handoffFrom: announce.sourceLane,
    delegationId: announce.delegationId,
    runId: announce.transcriptRunId,
    task: announce.task,
    announceMessageId: announce.announceMessageId,
  };
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
    ? delegationAnnounceMessages(messages, scope)
    : messages.filter(getMessageIsAnnounce);
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

export function buildSubagentHandoff(params: {
  messages: BaseMessage[];
  lane: CapabilityMessageLane;
  transcriptRunId: string;
  delegationId: string;
  clearLane?: boolean;
  includeCopy?: boolean;
}): BaseMessage[] | null {
  const scope: DelegationMessageScope = {
    lane: params.lane,
    transcriptRunId: params.transcriptRunId,
    delegationId: params.delegationId,
  };
  const announceMessages = delegationAnnounceMessages(params.messages, scope);
  if (announceMessages.length === 0) return null;

  const removeMessages = params.clearLane === false
    ? []
    : params.messages.flatMap((message) => {
        if (!isMessageInDelegationScope(message, scope)) return [];
        const id = message.id;
        if (!id) {
          throw new Error('Delegation lane message is missing the required message id.');
        }
        return [new RemoveMessage({ id }) as BaseMessage];
      });
  if (params.includeCopy === false) return removeMessages;

  const handoffAnnounces = announceMessages.map((announceMessage) => {
    const announceMessageId = announceMessage.id;
    if (!announceMessageId) {
      throw new Error('Delegation announce is missing the required message id.');
    }
    return new DelegationAnnounceMessage({
      id: `delegation-announce:${params.transcriptRunId}:${params.delegationId}:${announceMessageId}`,
      sourceLane: params.lane,
      delegationId: params.delegationId,
      transcriptRunId: params.transcriptRunId,
      announceMessageId,
      task: getMessageDelegatedTask(announceMessage),
      completionReason: getMessageCompletionReason(announceMessage) ?? 'natural',
      result: readMessageText(announceMessage),
      createdAt: readAgentMessageCreatedAt(announceMessage) ?? new Date().toISOString(),
    });
  });
  return [...removeMessages, ...handoffAnnounces];
}

export function readLatestHumanRequest(messages: readonly BaseMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message._getType() !== 'human') continue;
    const text = readMessageText(message);
    if (text) return text;
  }
  return null;
}
