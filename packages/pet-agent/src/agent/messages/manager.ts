import type { BaseMessage } from '@langchain/core/messages';
import {
  getAgentMessageLane,
  type DelegationMessageScope,
} from './metadata';
import { makeToolProtocolSafe } from './protocol';
import {
  queryAgentMessages,
  type AgentMessageQueryExclusionReason,
  type AgentMessageQuerySource,
} from './query';

export type AgentMessageViewSource = AgentMessageQuerySource;

export type AgentMessageViewOverlay = {
  id: string;
  messages: readonly BaseMessage[];
};

export type AgentMessageProjectionContext = {
  source: AgentMessageViewSource | { id: string; kind: 'overlay' };
  canonical: boolean;
};

export type AgentMessageViewProjector = (
  message: BaseMessage,
  context: AgentMessageProjectionContext,
) => BaseMessage;

export type AgentMessageViewSpec = {
  name: string;
  audience: string;
  sources: readonly AgentMessageViewSource[];
  overlays?: readonly AgentMessageViewOverlay[];
  projector?: AgentMessageViewProjector;
  toolProtocol?: 'safe' | 'preserve';
};

export type AgentMessageViewManifestItem = {
  messageId: string;
  sourceId: string;
  sourceKind: AgentMessageViewSource['kind'] | 'overlay';
  lane: string | null;
  canonical: boolean;
  projected: boolean;
};

export type AgentMessageViewManifestExcludedItem = {
  messageId: string;
  sourceId: string | null;
  lane: string | null;
  canonical: boolean;
  reason: AgentMessageQueryExclusionReason | 'tool_protocol';
};

export type AgentMessageViewManifest = {
  version: 1;
  name: string;
  audience: string;
  canonicalMessageCount: number;
  selectedCanonicalCount: number;
  overlayCount: number;
  outputMessageCount: number;
  excludedCanonicalCount: number;
  toolProtocolRemovedMessageIds: string[];
  sources: Array<{
    id: string;
    kind: AgentMessageViewSource['kind'];
    selectedCount: number;
    scope?: DelegationMessageScope;
    visibility?: 'transcript' | 'announces_only';
  }>;
  items: AgentMessageViewManifestItem[];
  excludedItems: AgentMessageViewManifestExcludedItem[];
};

export type AgentMessageView = {
  messages: BaseMessage[];
  /** Final provider messages partitioned by their named source. */
  messagesBySource: Readonly<Record<string, readonly BaseMessage[]>>;
  manifest: AgentMessageViewManifest;
};

function messageIdentity(message: BaseMessage, index: number, prefix = 'canonical') {
  return message.id ?? `${prefix}:${index.toString()}`;
}

function assertMessageViewSpec(spec: AgentMessageViewSpec) {
  const ids = [
    ...spec.sources.map((source) => source.id),
    ...(spec.overlays ?? []).map((overlay) => overlay.id),
  ];
  if (ids.some((id) => !id.trim())) {
    throw new Error('Agent message view source ids must be non-empty.');
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error('Agent message view source ids must be unique.');
  }
}

export function composeAgentMessageView(
  canonicalMessages: readonly BaseMessage[],
  spec: AgentMessageViewSpec,
): AgentMessageView {
  assertMessageViewSpec(spec);
  const query = queryAgentMessages(canonicalMessages, spec.sources);
  const selected: Array<{
    message: BaseMessage;
    source: AgentMessageViewSource | { id: string; kind: 'overlay' };
    canonical: boolean;
    identity: string;
  }> = [];
  for (const { message, source, canonicalIndex } of query.selected) {
    selected.push({
      message,
      source,
      canonical: true,
      identity: messageIdentity(message, canonicalIndex),
    });
  }

  for (const overlay of spec.overlays ?? []) {
    overlay.messages.forEach((message, index) => {
      selected.push({
        message,
        source: { id: overlay.id, kind: 'overlay' },
        canonical: false,
        identity: messageIdentity(message, index, `overlay:${overlay.id}`),
      });
    });
  }

  const projected = selected.map((item) => {
    const message = spec.projector
      ? spec.projector(item.message, {
          source: item.source,
          canonical: item.canonical,
        })
      : item.message;
    return { ...item, projectedMessage: message };
  });
  const projectionByMessage = new Map<BaseMessage, typeof projected>();
  for (const item of projected) {
    const items = projectionByMessage.get(item.projectedMessage) ?? [];
    items.push(item);
    projectionByMessage.set(item.projectedMessage, items);
  }
  const protocol = spec.toolProtocol === 'preserve'
    ? { messages: projected.map((item) => item.projectedMessage), removedMessageIds: [] }
    : makeToolProtocolSafe(projected.map((item) => item.projectedMessage));
  const retainedItems = protocol.messages.flatMap((message) => {
    const item = projectionByMessage.get(message)?.shift();
    return item ? [item] : [];
  });
  const protocolRemovedItems = [...projectionByMessage.values()].flat();
  const messagesBySource = retainedItems.reduce<Record<string, BaseMessage[]>>(
    (partitions, item) => {
      (partitions[item.source.id] ??= []).push(item.projectedMessage);
      return partitions;
    },
    {},
  );

  const selectedCanonicalCount = query.selected.length;
  const overlayCount = selected.length - selectedCanonicalCount;
  for (const messages of Object.values(messagesBySource)) Object.freeze(messages);
  return {
    messages: protocol.messages,
    messagesBySource: Object.freeze(messagesBySource),
    manifest: {
      version: 1,
      name: spec.name,
      audience: spec.audience,
      canonicalMessageCount: canonicalMessages.length,
      selectedCanonicalCount,
      overlayCount,
      outputMessageCount: protocol.messages.length,
      excludedCanonicalCount: query.excluded.length,
      toolProtocolRemovedMessageIds: protocol.removedMessageIds,
      sources: spec.sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        selectedCount: query.selectedCounts.get(source.id) ?? 0,
        ...(source.kind === 'delegation'
          ? { scope: source.scope, visibility: source.visibility }
          : {}),
      })),
      items: retainedItems.map((item) => ({
        messageId: item.identity,
        sourceId: item.source.id,
        sourceKind: item.source.kind,
        lane: getAgentMessageLane(item.message),
        canonical: item.canonical,
        projected: item.projectedMessage !== item.message,
      })),
      excludedItems: [
        ...query.excluded.map((item) => ({
          messageId: messageIdentity(item.message, item.canonicalIndex),
          sourceId: item.source?.id ?? null,
          lane: getAgentMessageLane(item.message),
          canonical: true,
          reason: item.reason,
        })),
        ...protocolRemovedItems.map((item) => ({
          messageId: item.identity,
          sourceId: item.source.id,
          lane: getAgentMessageLane(item.message),
          canonical: item.canonical,
          reason: 'tool_protocol' as const,
        })),
      ],
    },
  };
}

export function createAgentMessageManager(canonicalMessages: readonly BaseMessage[]) {
  return Object.freeze({
    compose(spec: AgentMessageViewSpec) {
      return composeAgentMessageView(canonicalMessages, spec);
    },
    main(params: Omit<AgentMessageViewSpec, 'sources'>) {
      return composeAgentMessageView(canonicalMessages, {
        ...params,
        sources: [{ id: 'main', kind: 'main' }],
      });
    },
    delegation(params: Omit<AgentMessageViewSpec, 'sources'> & {
      scope: DelegationMessageScope;
      visibility?: 'transcript' | 'announces_only';
      includeMain?: boolean;
    }) {
      return composeAgentMessageView(canonicalMessages, {
        ...params,
        sources: [
          ...(params.includeMain === false
            ? []
            : [{ id: 'main', kind: 'main' } as const]),
          {
            id: 'delegation',
            kind: 'delegation',
            scope: params.scope,
            visibility: params.visibility ?? 'transcript',
          },
        ],
      });
    },
  });
}

export type AgentMessageManager = ReturnType<typeof createAgentMessageManager>;

export function mainConversationMessages(messages: readonly BaseMessage[]) {
  return createAgentMessageManager(messages).main({
    name: 'main_conversation',
    audience: 'agent_internal',
    toolProtocol: 'preserve',
  }).messages;
}

export function delegationTranscriptMessages(
  messages: readonly BaseMessage[],
  scope: DelegationMessageScope,
) {
  return createAgentMessageManager(messages).delegation({
    name: 'delegation_transcript',
    audience: scope.lane,
    scope,
  }).messages;
}

export function laneMessages(
  messages: readonly BaseMessage[],
  lane: DelegationMessageScope['lane'],
  transcriptRunId: string,
  delegationId: string,
) {
  return delegationTranscriptMessages(messages, {
    lane,
    transcriptRunId,
    delegationId,
  });
}

export function delegationAnnounceMessages(
  messages: readonly BaseMessage[],
  scope: DelegationMessageScope,
) {
  return createAgentMessageManager(messages).delegation({
    name: 'delegation_announces',
    audience: 'agent_internal',
    scope,
    includeMain: false,
    visibility: 'announces_only',
    toolProtocol: 'preserve',
  }).messages;
}
