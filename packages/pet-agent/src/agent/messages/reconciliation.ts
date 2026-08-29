import { RemoveMessage, type BaseMessage } from '@langchain/core/messages';
import {
  ensureAgentMessageId,
  getAgentMessageDelegationScope,
  getAgentMessageLane,
  setAgentMessageDelegationScope,
  type DelegationMessageScope,
} from './metadata';
import { delegationMessageScopesEqual } from './metadata';
import { toolProtocolSafeMessages } from './protocol';

export type ReconcileDelegationMessagesParams = {
  resultMessages: readonly BaseMessage[];
  inputMessages: readonly BaseMessage[];
  persistedInputMessages?: readonly BaseMessage[];
  scope: DelegationMessageScope;
};

/**
 * Reconcile one child transcript without assigning orchestrator-domain meaning
 * such as Announce or completion. Invocation-only overlays may be present in
 * inputMessages but must be omitted from persistedInputMessages.
 */
export function reconcileDelegationMessages(
  params: ReconcileDelegationMessagesParams,
): {
  removed: BaseMessage[];
  added: BaseMessage[];
} {
  const existingRefs = new Set(params.inputMessages);
  const existingIds = new Set(params.inputMessages.flatMap((message) =>
    message.id ? [message.id] : []));
  const resultIds = new Set(params.resultMessages.flatMap((message) =>
    message.id ? [message.id] : []));
  const persistedInputMessages = params.persistedInputMessages ?? params.inputMessages;
  const removed = persistedInputMessages.flatMap((message) => {
    if (!message.id || resultIds.has(message.id)) return [];
    const scope = getAgentMessageDelegationScope(message);
    if (!scope || !delegationMessageScopesEqual(scope, params.scope)) return [];
    return [new RemoveMessage({ id: message.id }) as BaseMessage];
  });
  const added = params.resultMessages.filter((message) => {
    if (existingRefs.has(message)) return false;
    return !message.id || !existingIds.has(message.id);
  });
  for (const message of added) {
    ensureAgentMessageId(message);
    setAgentMessageDelegationScope(message, params.scope);
  }

  return {
    removed,
    added: toolProtocolSafeMessages(added),
  };
}

export function isMessageInDelegationScope(
  message: BaseMessage,
  scope: DelegationMessageScope,
) {
  if (getAgentMessageLane(message) !== scope.lane) return false;
  const messageScope = getAgentMessageDelegationScope(message);
  return Boolean(messageScope && delegationMessageScopesEqual(messageScope, scope));
}
