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
 * 'v3')` run into the local-agent chat event vocabulary. Since #322 Phase 4
 * this is the production consumption path (the legacy
 * `graph.stream(['messages','values','custom'])` + `onToolEvent` bridge is
 * gone); the correspondence with the legacy semantics is pinned by tests and
 * documented in docs/SUBAGENT_STREAM_BRIDGE_ANALYSIS.md.
 *
 * Attribution model (established by the Phase 1 spike):
 * - namespace depth 0/1 = the root graph / a root node's own activity;
 * - namespace depth >= 2 = a delegated child scope (subagent model calls,
 *   tool executions run inside a child agent);
 * - the node name is the first segment of a namespace entry (`"answer:<task>"`).
 *
 * Scope granularities differ on purpose:
 * - The main assistant reply streams as token deltas (the user is waiting on
 *   it) with the legacy prefix dedup against the state echo.
 * - Subagent output is an ambient progress feed with MULTIPLE messages per
 *   run; it is emitted as one completed `subagent.message` per model message
 *   lifecycle. Token-level dedup across messages is unsound there (a legit
 *   new message can extend or repeat earlier text), and depth-1 lane echoes
 *   of child messages are dropped entirely — matching the legacy
 *   `isLaneTaggedAiMessage` skip.
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
  /** One completed subagent model message (ambient progress, block-level). */
  | { type: 'subagent.message'; namespace: string[]; messageId: string; text: string }
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
 * Depth-1 lane message events are echoes of state the lane node writes
 * (announces, copied child messages); the live subagent feed comes from the
 * depth >= 2 child scopes, so lane echoes are dropped — as legacy does.
 */
const DELEGATION_LANE_NODE_NAMES = new Set(['capability', 'general']);
const INTERNAL_SUBAGENT_MESSAGE_NODE_NAMES = new Set([
  'SummarizationMiddleware.before_model',
]);

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
 * Per-namespace lifecycle tracking: `content-block-delta` events carry no
 * message id — within one namespace they belong to the message opened by the
 * most recent `message-start` there. Subagent lifecycles additionally buffer
 * their text so the message can be emitted whole on `message-finish`.
 */
export type RootStreamAdapterState = Map<string, {
  messageId: string;
  role: string;
  buffer: string;
  lastEmitted: string;
}>;

export function namespaceKey(namespace: string[]): string {
  return namespace.join('|');
}

function currentLifecycle(state: RootStreamAdapterState, key: string) {
  let entry = state.get(key);
  if (!entry) {
    entry = { messageId: '', role: '', buffer: '', lastEmitted: '' };
    state.set(key, entry);
  }
  return entry;
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
      const key = namespaceKey(namespace);
      if (data.event === 'message-start') {
        const previous = state.get(key);
        state.set(key, {
          messageId: typeof data.id === 'string' ? data.id : '',
          role: typeof data.role === 'string' ? data.role : '',
          buffer: '',
          lastEmitted: previous?.lastEmitted ?? '',
        });
        return null;
      }
      const current = currentLifecycle(state, key);
      // Mirrors the legacy `_getType() === 'ai'` filter. Model streams omit
      // the role on message-start (they are AI-authored by construction), so
      // only a KNOWN non-assistant role excludes a lifecycle.
      if (current.role && current.role !== 'ai' && current.role !== 'assistant') {
        return null;
      }

      if (namespace.length >= 2) {
        const childNode = readNamespaceNode(namespace, 1);
        if (childNode && INTERNAL_SUBAGENT_MESSAGE_NODE_NAMES.has(childNode)) {
          // The summarization model call is an implementation detail of the
          // child agent. Its output becomes persisted context, not ambient
          // progress shown to the user.
          if (data.event === 'message-finish') {
            current.buffer = '';
          }
          return null;
        }
        // Subagent scope: buffer deltas, emit the whole message on finish.
        const text = readTextDelta(data);
        if (text) {
          current.buffer += text;
          return null;
        }
        if (data.event === 'message-finish') {
          const message = current.buffer;
          current.buffer = '';
          if (!message) {
            return null;
          }
          // A same-namespace state echo replays the message as a second
          // full-content lifecycle; drop consecutive identical messages.
          if (message === current.lastEmitted) {
            return null;
          }
          current.lastEmitted = message;
          return {
            type: 'subagent.message',
            namespace,
            messageId: current.messageId,
            text: message,
          };
        }
        return null;
      }

      const text = readTextDelta(data);
      if (!text) {
        return null;
      }
      const node = readNamespaceNode(namespace);
      const isMain = options.isMainAssistantNode ?? defaultIsMainAssistantNode;
      if (!isMain(node)) {
        // Internal decision/discovery output and depth-1 lane echoes are
        // dropped (legacy: internal-node skip + lane-tag skip).
        return null;
      }
      return { type: 'assistant.delta', messageId: current.messageId, node, text };
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
 * The main assistant reply keeps the legacy prefix dedup: a node that streams
 * a model and then writes the resulting message back to state produces a
 * second full-content lifecycle (the state echo); a chunk whose text is a
 * prefix-replay of the accumulated reply contributes nothing new. Subagent
 * messages are deduplicated per lifecycle inside `readRootStreamChatEvent`.
 */
export async function* adaptRootStream(
  protocolEvents: AsyncIterable<RootProtocolEvent>,
  options: RootStreamAdapterOptions = {},
): AsyncGenerator<RootStreamChatEvent> {
  const state: RootStreamAdapterState = new Map();
  let assistantReply = '';
  for await (const event of protocolEvents) {
    const chatEvent = readRootStreamChatEvent(event, state, options);
    if (!chatEvent) {
      continue;
    }
    if (chatEvent.type === 'assistant.delta') {
      const token = chatEvent.text.startsWith(assistantReply)
        ? chatEvent.text.slice(assistantReply.length)
        : chatEvent.text;
      if (!token) {
        continue;
      }
      assistantReply += token;
      yield { ...chatEvent, text: token };
      continue;
    }
    yield chatEvent;
  }
}
