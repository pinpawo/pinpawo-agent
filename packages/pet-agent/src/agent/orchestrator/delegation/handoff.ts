import { RemoveMessage, type BaseMessage } from '@langchain/core/messages';
import {
  getAgentMessageLane,
  isMessageInDelegationScope,
  type CapabilityMessageLane,
  type DelegationMessageScope,
} from '../../messages';
import {
  DelegationAnnounceMessage,
  getDelegationAnnounce,
  selectDelegationAnnounceMessages,
} from './announce';

export type HandoffSource = {
  handoffFrom: CapabilityMessageLane;
  delegationId: string;
  runId: string;
  task: string | null;
  announceMessageId: string;
};

export function getMessageHandoffSource(message: BaseMessage): HandoffSource | null {
  if (getAgentMessageLane(message)) return null;
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
  const announceMessages = selectDelegationAnnounceMessages(params.messages, scope)
    .flatMap((message) => {
      const announce = getDelegationAnnounce(message);
      return announce ? [announce] : [];
    });
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

  const handoffAnnounces = announceMessages.map((announce) => {
    return new DelegationAnnounceMessage({
      id: `delegation-announce:${announce.runId}:${announce.delegationId}:${announce.announceMessageId}`,
      sourceLane: announce.sourceLane,
      delegationId: announce.delegationId,
      runId: announce.runId,
      announceMessageId: announce.announceMessageId,
      task: announce.task,
      completionReason: announce.completionReason,
      result: announce.result,
      createdAt: announce.createdAt,
    });
  });
  return [...removeMessages, ...handoffAnnounces];
}
