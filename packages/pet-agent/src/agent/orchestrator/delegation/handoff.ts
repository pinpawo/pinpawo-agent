import { RemoveMessage, type BaseMessage } from '@langchain/core/messages';
import {
  isMessageInDelegationScope,
  queryAgentMessages,
  readAgentMessageCreatedAt,
  type CapabilityMessageLane,
  type DelegationMessageScope,
} from '../../messages';
import {
  DelegationAnnounceMessage,
  getDelegationAnnounce,
  getMessageCompletionReason,
  getMessageDelegatedTask,
  getMessageIsAnnounce,
} from './announce';
import { readMessageText } from '../utils';

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
    runId: announce.runId,
    task: announce.task,
    announceMessageId: announce.announceMessageId,
  };
}

export function buildSubagentHandoff(params: {
  messages: BaseMessage[];
  lane: CapabilityMessageLane;
  runId: string;
  delegationId: string;
  clearLane?: boolean;
  includeCopy?: boolean;
}): BaseMessage[] | null {
  const scope: DelegationMessageScope = {
    lane: params.lane,
    runId: params.runId,
    delegationId: params.delegationId,
  };
  const announceMessages = queryAgentMessages(params.messages)
    .delegation(scope)
    .select()
    .messages
    .filter(getMessageIsAnnounce);
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
      id: `delegation-announce:${params.runId}:${params.delegationId}:${announceMessageId}`,
      sourceLane: params.lane,
      delegationId: params.delegationId,
      runId: params.runId,
      announceMessageId,
      task: getMessageDelegatedTask(announceMessage),
      completionReason: getMessageCompletionReason(announceMessage) ?? 'natural',
      result: readMessageText(announceMessage),
      createdAt: readAgentMessageCreatedAt(announceMessage) ?? new Date().toISOString(),
    });
  });
  return [...removeMessages, ...handoffAnnounces];
}
