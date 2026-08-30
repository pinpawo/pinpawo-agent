import type { BaseMessage } from '@langchain/core/messages';
import type { SubagentCompletionReason } from '../../../types/subagent';
import {
  reconcileDelegationMessages,
  setAgentMessageMetadata,
  type CapabilityMessageLane,
  type DelegationMessageScope,
} from '../../messages';
import { setMessageIsAnnounce } from './announce';

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
  canonicalInputMessages: BaseMessage[] = existingMessages,
) {
  const delegationId = reportMeta.delegationId?.trim();
  if (!delegationId) {
    throw new Error('Delegation transcript reconciliation requires delegationId.');
  }
  const scope: DelegationMessageScope = { lane, transcriptRunId, delegationId };
  const reconciled = reconcileDelegationMessages({
    resultMessages: messages,
    inputMessages: existingMessages,
    canonicalInputMessages,
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
