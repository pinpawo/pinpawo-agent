import type { BaseMessage } from '@langchain/core/messages';
import type { SubagentCompletionReason } from '../../../types/subagent';
import {
  queryAgentMessages,
  type DelegationMessageScope,
} from '../../messages';
import {
  getDelegationAnnounce,
  type DelegationAnnounceData,
} from './announceMessage';

export * from './announceMessage';

export type DelegationAnnounceSelector = DelegationMessageScope & {
  announceMessageId?: string | null;
};

export function selectDelegationAnnounceMessages(
  messages: readonly BaseMessage[],
  options: DelegationAnnounceSelector,
): BaseMessage[] {
  const scope: DelegationMessageScope = {
    lane: options.lane,
    runId: options.runId,
    delegationId: options.delegationId,
  };
  const candidates = queryAgentMessages(messages).delegation(scope).select().messages;
  return candidates.filter((message) => {
    const announce = getDelegationAnnounce(message);
    if (!announce) return false;
    if (announce.sourceLane !== scope.lane
      || announce.runId !== scope.runId
      || announce.delegationId !== scope.delegationId) return false;
    if (options.announceMessageId
      && announce.announceMessageId !== options.announceMessageId) return false;
    return true;
  });
}

export function selectDelegationAnnounceMessage(
  messages: readonly BaseMessage[],
  options: DelegationAnnounceSelector,
): BaseMessage | null {
  return selectDelegationAnnounceMessages(messages, options).at(-1) ?? null;
}

export function readLatestAnnounce(
  messages: readonly BaseMessage[],
  options: DelegationAnnounceSelector,
): DelegationAnnounceData | null {
  const message = selectDelegationAnnounceMessage(messages, options);
  return message ? getDelegationAnnounce(message) : null;
}

export function readLatestAnnounceCompletionReason(
  messages: readonly BaseMessage[],
  options: DelegationAnnounceSelector,
): SubagentCompletionReason | null {
  return readLatestAnnounce(messages, options)?.completionReason ?? null;
}
