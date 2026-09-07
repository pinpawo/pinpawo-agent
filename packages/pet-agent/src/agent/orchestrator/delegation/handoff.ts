import { AIMessage, RemoveMessage, type BaseMessage } from '@langchain/core/messages';
import {
  getAgentMessageLane,
  isMessageInDelegationScope,
  type CapabilityMessageLane,
  type DelegationMessageScope,
} from '../../messages';
import {
  getDelegationAnnounce,
  selectDelegationAnnounceMessages,
} from './announce';

export type HandoffSource = {
  handoffFrom: CapabilityMessageLane;
  delegationId: string;
  runId: string;
  task: string | null;
  announceMessageId: string;
  taskAccepted: boolean | null;
};

export function getMessageHandoffSource(message: BaseMessage): HandoffSource | null {
  if (getAgentMessageLane(message)) return null;
  const announce = getDelegationAnnounce(message);
  if (!announce) return null;
  const metadata = message.additional_kwargs?.pinpawo as Record<string, unknown> | undefined;
  return {
    taskAccepted: typeof metadata?.taskAccepted === 'boolean' ? metadata.taskAccepted : null,
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
  taskAccepted: boolean;
}): BaseMessage[] | null {
  const scope: DelegationMessageScope = {
    lane: params.lane,
    runId: params.runId,
    delegationId: params.delegationId,
  };
  const announceMessages = selectDelegationAnnounceMessages(params.messages, scope);
  if (announceMessages.length === 0) return null;

  const removeMessages = params.messages.flatMap((message) => {
        if (!isMessageInDelegationScope(message, scope)) return [];
        const id = message.id;
        if (!id) {
          throw new Error('Delegation lane message is missing the required message id.');
        }
        return [new RemoveMessage({ id }) as BaseMessage];
      });

  const handoffAnnounces = announceMessages.map((message) => {
    if (!message.id) throw new Error('Delegation Announce is missing its stable message id.');
    return new AIMessage({
      ...message,
      id: message.id,
      content: message.content,
      additional_kwargs: {
        ...message.additional_kwargs,
        pinpawo: {
          ...message.additional_kwargs.pinpawo as Record<string, unknown>,
          taskAccepted: params.taskAccepted,
        },
      },
    });
  });
  return [...removeMessages, ...handoffAnnounces];
}
