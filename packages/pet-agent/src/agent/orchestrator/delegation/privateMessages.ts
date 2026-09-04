import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { SubagentCompletionReason } from '../../../types/subagent';
import {
  readAgentMessageCreatedAt,
  reconcileDelegationMessages,
  setAgentMessageDelegationScope,
  type CapabilityMessageLane,
  type DelegationMessageScope,
} from '../../messages';
import { DelegationAnnounceMessage } from './announceMessage';
import { readMessageText } from '../utils';

export function reconcileDelegationPrivateMessages(
  resultMessages: BaseMessage[],
  modelInputMessages: BaseMessage[],
  lane: CapabilityMessageLane,
  runId: string,
  completionReason: SubagentCompletionReason | null,
  reportMeta: {
    delegationId?: string | null;
    task?: string | null;
    announceMessageId?: string | null;
  } = {},
  canonicalMessages: BaseMessage[] = modelInputMessages,
) {
  const delegationId = reportMeta.delegationId?.trim();
  if (!delegationId) {
    throw new Error('Delegation private-message reconciliation requires delegationId.');
  }
  const scope: DelegationMessageScope = { lane, runId, delegationId };
  const reconciled = reconcileDelegationMessages({
    resultMessages,
    inputMessages: modelInputMessages,
    canonicalInputMessages: canonicalMessages,
    scope,
  });
  const announceMessage = reportMeta.announceMessageId
    ? reconciled.added.find((message) => message.id === reportMeta.announceMessageId)
    : null;
  if (announceMessage && !completionReason) {
    throw new Error('Delegation announce requires a genuine subagent completion reason.');
  }
  const added = reconciled.added.map((message) => {
    if (message !== announceMessage) return message;
    const announceMessageId = message.id;
    if (!announceMessageId) {
      throw new Error('Delegation announce is missing the required message id.');
    }
    const typedAnnounce = new DelegationAnnounceMessage({
      id: announceMessageId,
      sourceLane: lane,
      delegationId,
      runId,
      announceMessageId,
      task: reportMeta.task ?? null,
      completionReason: completionReason as SubagentCompletionReason,
      result: readMessageText(message),
      createdAt: readAgentMessageCreatedAt(message) ?? new Date().toISOString(),
    });
    if (AIMessage.isInstance(message)) {
      typedAnnounce.name = message.name;
      typedAnnounce.response_metadata = message.response_metadata;
      typedAnnounce.usage_metadata = message.usage_metadata;
    }
    return setAgentMessageDelegationScope(typedAnnounce, scope);
  });
  return [...reconciled.removed, ...added];
}
