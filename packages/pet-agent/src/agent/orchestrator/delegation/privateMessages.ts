import type { BaseMessage } from '@langchain/core/messages';
import type { SubagentCompletionReason } from '../../../types/subagent';
import {
  reconcileDelegationMessages,
  setAgentMessageMetadata,
  type CapabilityMessageLane,
  type DelegationMessageScope,
} from '../../messages';
import { setMessageIsAnnounce } from './announce';

export function reconcileDelegationPrivateMessages(
  resultMessages: BaseMessage[],
  modelInputMessages: BaseMessage[],
  lane: CapabilityMessageLane,
  runId: string,
  completionReason: SubagentCompletionReason,
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
  if (announceMessage) {
    setMessageIsAnnounce(announceMessage);
    setAgentMessageMetadata(announceMessage, {
      task: reportMeta.task ?? null,
      completionReason,
    });
  }
  return [...reconciled.removed, ...reconciled.added];
}
