import {
  GUARD_DECISION_EVENT,
  isOrchestratorInternalAiStreamNode,
  SUBAGENT_GUARD_DECISION_EVENT,
  type GuardDecisionRecord,
} from '@pinpawo/pet-agent';

/**
 * Root event-stream adapter (#322 Phase 2).
 *
 * Translates the RAW protocol events of a root `graph.streamEvents(version:
 * 'v3')` run into the local-agent chat event vocabulary. This is the parallel
 * consumption path to the legacy `graph.stream(['messages','values','custom'])`
 * + `onToolEvent` bridge — nothing existing is rewired yet; the correspondence
 * is pinned by tests and documented in docs/SUBAGENT_STREAM_BRIDGE_ANALYSIS.md.
 *
 * Attribution model (established by the Phase 1 spike):
 * - namespace depth 0/1 = the root graph / a root node's own activity;
 * - namespace depth >= 2 = a delegated child scope (subagent model calls,
 *   tool executions run inside a child agent);
 * - the node name is the first segment of a namespace entry (`"answer:<task>"`).
 *
 * The adapter deliberately consumes the protocol stream, not the ergonomic
 * projections (`run.messages` etc.), which showed subscription-timing
 * sensitivity in the spike.
 */

/** Structural subset of LangGraph's v3 ProtocolEvent that the adapter reads. */
export type RootProtocolEvent = {
  type: 'event';
  seq: number;
  method: string;
  params: {
    namespace?: string[];
    data?: unknown;
    [key: string]: unknown;
  };
};

export type RootStreamChatEvent =
  /** Main-conversation assistant tokens (the user-facing reply stream). */
  | { type: 'assistant.delta'; messageId: string; node: string | null; text: string }
  /** Model tokens from a delegated child scope (subagent lanes). */
  | { type: 'subagent.delta'; namespace: string[]; messageId: string; text: string }
  /** Tool lifecycle from any scope; Phase 3 joins operation metadata. */
  | { type: 'tool'; namespace: string[]; data: Record<string, unknown> }
  /** A guard decision record (orchestrator via stream writer; subagent after Phase 4). */
  | { type: 'guard.decision'; record: GuardDecisionRecord }
  /** Any other custom runtime event written to the stream writer. */
  | { type: 'runtime.custom'; name: string; data: unknown }
  /** Root state snapshot (drives final-messages tracking). */
  | { type: 'values'; values: Record<string, unknown> }
  /** The run paused on an interrupt (human review etc.). */
  | { type: 'interrupt'; interrupts: unknown[] };

/**
 * Nodes whose depth-1 message activity belongs to a delegation lane, not the
 * main assistant reply. Mirrors the legacy `isLaneTaggedAiMessage` filter:
 * lane tags live on `additional_kwargs`, which protocol message events do not
 * carry, so under root streaming the lane boundary is expressed by node name.
 */
const DELEGATION_LANE_NODE_NAMES = new Set(['capability', 'general']);

export function readNamespaceNode(namespace: string[] | undefined, index = 0): string | null {
  const segment = namespace?.[index];
  if (typeof segment !== 'string' || segment.length === 0) {
    return null;
  }
  const separator = segment.indexOf(':');
  return separator > 0 ? segment.slice(0, separator) : segment;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readTextDelta(data: Record<string, unknown>): string | null {
  if (data.event !== 'content-block-delta') {
    return null;
  }
  const delta = readRecord(data.delta);
  if (!delta || delta.type !== 'text-delta') {
    return null;
  }
  return typeof delta.text === 'string' && delta.text.length > 0 ? delta.text : null;
}

function isGuardDecisionCustomData(data: Record<string, unknown>): boolean {
  return data.name === GUARD_DECISION_EVENT || data.name === SUBAGENT_GUARD_DECISION_EVENT;
}

export type RootStreamAdapterOptions = {
  /**
   * Assistant-reply node filter for depth-1 message activity. Defaults to the
   * legacy behavior: drop orchestrator-internal AI stream nodes and
   * delegation-lane nodes; everything else is main assistant output.
   */
  isMainAssistantNode?: (node: string | null) => boolean;
};

function defaultIsMainAssistantNode(node: string | null): boolean {
  if (node === null) {
    return true;
  }
  if (isOrchestratorInternalAiStreamNode(node)) {
    return false;
  }
  return !DELEGATION_LANE_NODE_NAMES.has(node);
}

/**
 * Per-run adapter state: `content-block-delta` events carry no message id —
 * within one namespace they belong to the message opened by the most recent
 * `message-start` there — so the current message is tracked per namespace.
 */
export type RootStreamAdapterState = Map<string, { messageId: string; role: string }>;

function namespaceKey(namespace: string[]): string {
  return namespace.join('|');
}

/**
 * Translate one protocol event; returns null for events the chat surface does
 * not consume (checkpoints, tasks, updates, lifecycle, non-AI messages…).
 */
export function readRootStreamChatEvent(
  event: RootProtocolEvent,
  state: RootStreamAdapterState,
  options: RootStreamAdapterOptions = {},
): RootStreamChatEvent | null {
  const namespace = (event.params.namespace ?? []) as string[];
  const data = readRecord(event.params.data);

  switch (event.method) {
    case 'messages': {
      if (!data) {
        return null;
      }
      if (data.event === 'message-start') {
        state.set(namespaceKey(namespace), {
          messageId: typeof data.id === 'string' ? data.id : '',
          role: typeof data.role === 'string' ? data.role : '',
        });
        return null;
      }
      const current = state.get(namespaceKey(namespace));
      // Mirrors the legacy `_getType() === 'ai'` filter. Model streams omit
      // the role on message-start (they are AI-authored by construction), so
      // only a KNOWN non-assistant role excludes a lifecycle.
      if (current && current.role && current.role !== 'ai' && current.role !== 'assistant') {
        return null;
      }
      const messageId = current?.messageId ?? '';
      const text = readTextDelta(data);
      if (!text) {
        return null;
      }
      if (namespace.length >= 2) {
        return { type: 'subagent.delta', namespace, messageId, text };
      }
      const node = readNamespaceNode(namespace);
      const isMain = options.isMainAssistantNode ?? defaultIsMainAssistantNode;
      if (!isMain(node)) {
        // Internal decision/discovery output is dropped; delegation-lane
        // depth-1 output is subagent scope.
        return DELEGATION_LANE_NODE_NAMES.has(node ?? '')
          ? { type: 'subagent.delta', namespace, messageId, text }
          : null;
      }
      return { type: 'assistant.delta', messageId, node, text };
    }

    case 'tools': {
      if (!data) {
        return null;
      }
      return { type: 'tool', namespace, data };
    }

    case 'custom': {
      if (!data) {
        return null;
      }
      if (isGuardDecisionCustomData(data)) {
        const record = readRecord(data.data);
        return record ? { type: 'guard.decision', record: record as GuardDecisionRecord } : null;
      }
      if (typeof data.name === 'string') {
        return { type: 'runtime.custom', name: data.name, data: data.data };
      }
      return { type: 'runtime.custom', name: 'unknown', data: data.payload ?? data };
    }

    case 'values': {
      // Only root-level values drive final-messages/interrupt handling —
      // child values are that child's internal state.
      if (namespace.length > 0 || !data) {
        return null;
      }
      if ('__interrupt__' in data && Array.isArray(data.__interrupt__)) {
        return { type: 'interrupt', interrupts: data.__interrupt__ };
      }
      return { type: 'values', values: data };
    }

    default:
      return null;
  }
}

/**
 * Adapt a root v3 protocol stream into chat events. Adapter state is scoped
 * per run; the caller just iterates.
 *
 * Delta streams are deduplicated per scope with the same prefix trick the
 * legacy consumption uses: a node that streams a model and then writes the
 * resulting message back to state produces a second full-content lifecycle
 * (the state echo); a chunk whose text is a prefix-replay of the scope's
 * accumulated text contributes nothing new and is dropped.
 */
export async function* adaptRootStream(
  protocolEvents: AsyncIterable<RootProtocolEvent>,
  options: RootStreamAdapterOptions = {},
): AsyncGenerator<RootStreamChatEvent> {
  const state: RootStreamAdapterState = new Map();
  const accumulatedByScope = new Map<string, string>();
  for await (const event of protocolEvents) {
    const chatEvent = readRootStreamChatEvent(event, state, options);
    if (!chatEvent) {
      continue;
    }
    if (chatEvent.type === 'assistant.delta' || chatEvent.type === 'subagent.delta') {
      // Subagent scopes share the top-level lane segment: a lane node that
      // echoes its child's message into parent state replays the child's
      // stream one namespace level up, and must dedupe against it.
      const scope = chatEvent.type === 'assistant.delta'
        ? 'assistant'
        : `lane:${chatEvent.namespace[0] ?? ''}`;
      const accumulated = accumulatedByScope.get(scope) ?? '';
      const token = chatEvent.text.startsWith(accumulated)
        ? chatEvent.text.slice(accumulated.length)
        : chatEvent.text;
      if (!token) {
        continue;
      }
      accumulatedByScope.set(scope, accumulated + token);
      yield { ...chatEvent, text: token };
      continue;
    }
    yield chatEvent;
  }
}
