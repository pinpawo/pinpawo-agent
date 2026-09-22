import { RemoveMessage, type BaseMessage } from '@langchain/core/messages';
import {
  delegationMessageScopesEqual,
  getAgentMessageLane,
  isCapabilityMessageLane,
  queryAgentMessages,
  type DelegationMessageScope,
} from '../../messages';

/** Only the current delegation's resumable work; delivery belongs to its ToolMessage. */
export type CapabilityExecutionState = {
  scope: DelegationMessageScope & { taskId: string };
  messages: BaseMessage[];
};

export function capabilityStateMessages(
  state: CapabilityExecutionState | null | undefined,
  scope: CapabilityExecutionState['scope'],
): BaseMessage[] {
  return state && state.scope.taskId === scope.taskId && delegationMessageScopesEqual(state.scope, scope)
    ? state.messages : [];
}

/** One migration boundary for checkpoints written before private state was separated. */
function legacyCapabilityMessages(messages: readonly BaseMessage[]) {
  return messages.filter(message => isCapabilityMessageLane(getAgentMessageLane(message)));
}

export function removeLegacyCapabilityMessages(messages: readonly BaseMessage[]) {
  return legacyCapabilityMessages(messages).map(message => {
    if (!message.id) throw new Error('Checkpointed Capability messages must have stable IDs.');
    return new RemoveMessage({ id: message.id });
  });
}

export function restoreCapabilityState(
  state: CapabilityExecutionState | null | undefined,
  legacyMessages: readonly BaseMessage[],
  scope: CapabilityExecutionState['scope'],
): CapabilityExecutionState {
  return {
    scope,
    messages: state
      ? capabilityStateMessages(state, scope)
      : queryAgentMessages(legacyCapabilityMessages(legacyMessages)).delegation(scope).select().messages,
  };
}
