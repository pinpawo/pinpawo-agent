import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import {
  readAgentMessageCreatedAt,
  setAgentMessageMetadata,
  reconcileDelegationMessages,
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
  reportMeta: {
    traceId?: string;
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
  if (reportMeta.announceMessageId && (!announceMessage
    || !AIMessage.isInstance(announceMessage)
    || announceMessage.tool_calls?.length
    || !readMessageText(announceMessage).trim())) {
    throw new Error('Capability selected an invalid or non-new deliverable.');
  }
  const added = [...reconciled.added];
  if (announceMessage) {
    const announceMessageId = announceMessage.id!;
    added.push(setAgentMessageMetadata(new DelegationAnnounceMessage({
      id: `delegation-announce:${runId}:${delegationId}:${announceMessageId}`,
      sourceLane: lane,
      delegationId,
      runId,
      announceMessageId,
      task: reportMeta.task ?? null,
      result: readMessageText(announceMessage),
      createdAt: readAgentMessageCreatedAt(announceMessage) ?? new Date().toISOString(),
    }), { traceId: reportMeta.traceId }));
  }
  return [...reconciled.removed, ...added];
}
