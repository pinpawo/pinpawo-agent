import type { BaseMessage } from '@langchain/core/messages';
import {
  delegationMessageScopesEqual,
  getAgentMessageDelegationScope,
  getAgentMessageLane,
  isCapabilityMessageLane,
  type DelegationMessageScope,
} from './metadata';
import { toolProtocolSafeMessages } from './protocol';

export type AgentMessageSelectionExclusionReason =
  | 'main_not_selected'
  | 'delegation_not_selected'
  | 'scope_mismatch'
  | 'unsupported_lane';

export type AgentMessageSelectionDiagnostics = {
  canonicalMessageCount: number;
  selectedMessageIds: string[];
  excluded: Array<{
    messageId: string;
    reason: AgentMessageSelectionExclusionReason;
  }>;
};

export type AgentMessageSelection = {
  messages: BaseMessage[];
  diagnostics: AgentMessageSelectionDiagnostics;
};

export type AgentMessageQuery = {
  /** Include the untagged main conversation. */
  main(): AgentMessageQuery;
  /** Include one exact capability-delegation transcript. */
  delegation(scope: DelegationMessageScope): AgentMessageQuery;
  /** Materialize selected canonical messages in their original chronology. */
  select(): AgentMessageSelection;
};

type AgentMessageQueryState = {
  includeMain: boolean;
  delegationScopes: readonly DelegationMessageScope[];
};

function messageIdentity(message: BaseMessage, index: number) {
  return message.id ?? `canonical:${index.toString()}`;
}

function createQuery(
  canonicalMessages: readonly BaseMessage[],
  state: AgentMessageQueryState,
): AgentMessageQuery {
  return Object.freeze({
    main() {
      return state.includeMain
        ? createQuery(canonicalMessages, state)
        : createQuery(canonicalMessages, { ...state, includeMain: true });
    },
    delegation(scope: DelegationMessageScope) {
      if (state.delegationScopes.some((candidate) =>
        delegationMessageScopesEqual(candidate, scope))) {
        return createQuery(canonicalMessages, state);
      }
      return createQuery(canonicalMessages, {
        ...state,
        delegationScopes: [...state.delegationScopes, { ...scope }],
      });
    },
    select() {
      const messages: BaseMessage[] = [];
      const selectedMessageIds: string[] = [];
      const excluded: AgentMessageSelectionDiagnostics['excluded'] = [];

      canonicalMessages.forEach((message, index) => {
        const messageId = messageIdentity(message, index);
        const lane = getAgentMessageLane(message);
        if (!lane) {
          if (state.includeMain) {
            messages.push(message);
            selectedMessageIds.push(messageId);
          } else {
            excluded.push({ messageId, reason: 'main_not_selected' });
          }
          return;
        }

        if (!isCapabilityMessageLane(lane)) {
          excluded.push({ messageId, reason: 'unsupported_lane' });
          return;
        }
        if (state.delegationScopes.length === 0) {
          excluded.push({ messageId, reason: 'delegation_not_selected' });
          return;
        }

        const scope = getAgentMessageDelegationScope(message);
        if (!scope) {
          throw new Error(
            `Delegation lane message ${message.id ?? '(missing id)'} is missing delegationId or another part of its complete scope.`,
          );
        }
        if (!state.delegationScopes.some((candidate) =>
          delegationMessageScopesEqual(candidate, scope))) {
          excluded.push({ messageId, reason: 'scope_mismatch' });
          return;
        }
        messages.push(message);
        selectedMessageIds.push(messageId);
      });

      return {
        messages,
        diagnostics: {
          canonicalMessageCount: canonicalMessages.length,
          selectedMessageIds,
          excluded,
        },
      };
    },
  });
}

/**
 * Start an immutable query over canonical Agent messages. This layer only
 * chooses main/delegation transcripts; model-input construction belongs to the
 * node or subagent protocol that owns the invocation.
 */
export function queryAgentMessages(
  canonicalMessages: readonly BaseMessage[],
): AgentMessageQuery {
  const snapshot = [...canonicalMessages];
  return createQuery(snapshot, {
    includeMain: false,
    delegationScopes: [],
  });
}

export function mainConversationMessages(messages: readonly BaseMessage[]) {
  return queryAgentMessages(messages).main().select().messages;
}

export function delegationTranscriptMessages(
  messages: readonly BaseMessage[],
  scope: DelegationMessageScope,
) {
  return queryAgentMessages(messages).main().delegation(scope).select().messages;
}

export function laneMessages(
  messages: readonly BaseMessage[],
  lane: DelegationMessageScope['lane'],
  transcriptRunId: string,
  delegationId: string,
) {
  return toolProtocolSafeMessages(delegationTranscriptMessages(messages, {
    lane,
    transcriptRunId,
    delegationId,
  }));
}
