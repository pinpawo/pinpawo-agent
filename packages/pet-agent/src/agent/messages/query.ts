import type { BaseMessage } from '@langchain/core/messages';
import {
  delegationMessageScopesEqual,
  getAgentMessageDelegationScope,
  getAgentMessageLane,
  getAgentMessageMetadata,
  isCapabilityMessageLane,
  isInvocationOnlyAgentMessage,
  type DelegationMessageScope,
} from './metadata';

export type AgentMessageQuerySource =
  | {
      id: string;
      kind: 'main';
    }
  | {
      id: string;
      kind: 'delegation';
      scope: DelegationMessageScope;
      visibility: 'transcript' | 'announces_only';
    };

export type AgentMessageQueryExclusionReason =
  | 'invocation_only'
  | 'source_not_selected'
  | 'unsupported_lane'
  | 'scope_mismatch'
  | 'not_announce';

export type AgentMessageQuerySelection = {
  message: BaseMessage;
  canonicalIndex: number;
  source: AgentMessageQuerySource;
};

export type AgentMessageQueryExclusion = {
  message: BaseMessage;
  canonicalIndex: number;
  source?: AgentMessageQuerySource;
  reason: AgentMessageQueryExclusionReason;
};

export type AgentMessageQueryResult = {
  selected: AgentMessageQuerySelection[];
  excluded: AgentMessageQueryExclusion[];
  selectedCounts: ReadonlyMap<string, number>;
};

function assertAgentMessageQuerySources(
  sources: readonly AgentMessageQuerySource[],
) {
  const ids = sources.map((source) => source.id);
  if (ids.some((id) => !id.trim())) {
    throw new Error('Agent message query source ids must be non-empty.');
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error('Agent message query source ids must be unique.');
  }
  if (sources.filter((source) => source.kind === 'main').length > 1) {
    throw new Error('Agent message queries may contain at most one main source.');
  }
  const delegationSources = sources.filter((source) => source.kind === 'delegation');
  if (delegationSources.some((source, index) =>
    delegationSources.slice(index + 1).some((candidate) =>
      delegationMessageScopesEqual(source.scope, candidate.scope)))) {
    throw new Error('Agent message queries cannot assign one delegation scope twice.');
  }
}

/**
 * The single canonical-message query used by every view. It assigns each
 * selected message to one named source and records why every other canonical
 * message was excluded. Projection, overlays, and provider protocol repair are
 * deliberately outside this layer.
 */
export function queryAgentMessages(
  canonicalMessages: readonly BaseMessage[],
  sources: readonly AgentMessageQuerySource[],
): AgentMessageQueryResult {
  assertAgentMessageQuerySources(sources);
  const selected: AgentMessageQuerySelection[] = [];
  const excluded: AgentMessageQueryExclusion[] = [];
  const selectedCounts = new Map(sources.map((source) => [source.id, 0]));
  const mainSource = sources.find((source) => source.kind === 'main');
  const delegationSources = sources.filter((source) => source.kind === 'delegation');

  canonicalMessages.forEach((message, canonicalIndex) => {
    const lane = getAgentMessageLane(message);
    if (!lane) {
      if (isInvocationOnlyAgentMessage(message)) {
        excluded.push({ message, canonicalIndex, reason: 'invocation_only' });
        return;
      }
      if (!mainSource) {
        excluded.push({ message, canonicalIndex, reason: 'source_not_selected' });
        return;
      }
      selected.push({ message, canonicalIndex, source: mainSource });
      selectedCounts.set(mainSource.id, (selectedCounts.get(mainSource.id) ?? 0) + 1);
      return;
    }

    if (!isCapabilityMessageLane(lane)) {
      excluded.push({ message, canonicalIndex, reason: 'unsupported_lane' });
      return;
    }
    if (delegationSources.length === 0) {
      excluded.push({ message, canonicalIndex, reason: 'source_not_selected' });
      return;
    }

    const scope = getAgentMessageDelegationScope(message);
    if (!scope) {
      throw new Error(
        `Delegation lane message ${message.id ?? '(missing id)'} is missing delegationId or another part of its complete scope.`,
      );
    }
    const source = delegationSources.find((candidate) =>
      delegationMessageScopesEqual(scope, candidate.scope));
    if (!source) {
      excluded.push({ message, canonicalIndex, reason: 'scope_mismatch' });
      return;
    }
    if (
      source.visibility === 'announces_only'
      && getAgentMessageMetadata(message).isAnnounce !== true
    ) {
      excluded.push({ message, canonicalIndex, source, reason: 'not_announce' });
      return;
    }
    selected.push({ message, canonicalIndex, source });
    selectedCounts.set(source.id, (selectedCounts.get(source.id) ?? 0) + 1);
  });

  return { selected, excluded, selectedCounts };
}
