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
 * - The main assistant reply streams only from the root `answer` node (or an
 *   unnamed root model scope) with prefix dedup against the state echo.
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
  /** A system-authored delegation briefing, projected from its protocol message. */
  | {
      type: 'delegation.briefing';
      namespace: string[];
      messageId: string;
      briefing: DelegationBriefing;
    }
  /** Tool lifecycle from any scope; Phase 3 joins operation metadata. */
  | { type: 'tool'; namespace: string[]; data: Record<string, unknown> }
  /** A guard decision record (orchestrator via stream writer; subagent after Phase 4). */
  | { type: 'guard.decision'; record: GuardDecisionRecord }
  /** Raw custom-channel event; known names are projected downstream and unknown names are ignored. */
  | { type: 'runtime.custom'; streamSequence: number; name: string; data: unknown }
  /** Root state snapshot (drives final-messages tracking). */
  | { type: 'values'; values: Record<string, unknown> }
  /** The run paused on an interrupt (human review etc.). */
  | { type: 'interrupt'; interrupts: unknown[] };

const MAIN_ASSISTANT_NODE_NAMES = new Set(['answer']);
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

export type DelegationBriefing = {
  mode: 'initial' | 'continue';
  task: string;
  essentialContext: string | null;
  gapNote: string | null;
};

/**
 * Read the fixed, system-authored delegation protocol at the stream boundary.
 * This is deliberately not a general XML parser: only the exact protocol
 * shape emitted by `materializeDelegation` is recognized. Any model-authored
 * XML-like text remains a normal subagent message.
 */
export function parseDelegationBriefing(text: string): DelegationBriefing | null {
  const header = /^<delegation_briefing role="task_boundary" source="orchestrator" mode="(initial|continue)">\s*/.exec(text);
  if (!header) return null;

  let offset = header[0].length;
  const task = readBriefingCdataElement(text, offset, 'task');
  if (!task) return null;
  offset = task.offset;

  const contextTag = header[1] === 'initial' ? 'essential_context' : 'gap_note';
  const context = readBriefingCdataElement(text, offset, contextTag);
  if (context) {
    offset = context.offset;
  }

  if (text.slice(offset).trim() !== '</delegation_briefing>') {
    return null;
  }

  const taskText = task.text.trim();
  if (!taskText) return null;
  return {
    mode: header[1] as DelegationBriefing['mode'],
    task: taskText,
    essentialContext: header[1] === 'initial' ? normalizeBriefingText(context?.text) : null,
    gapNote: header[1] === 'continue' ? normalizeBriefingText(context?.text) : null,
  };
}

function readBriefingCdataElement(
  source: string,
  initialOffset: number,
  tag: 'task' | 'essential_context' | 'gap_note',
): { text: string; offset: number } | null {
  let offset = skipWhitespace(source, initialOffset);
  const openTag = `<${tag}>`;
  if (!source.startsWith(openTag, offset)) return null;
  offset = skipWhitespace(source, offset + openTag.length);
  if (!source.startsWith('<![CDATA[', offset)) return null;
  offset += '<![CDATA['.length;

  let text = '';
  while (true) {
    const cdataEnd = source.indexOf(']]>', offset);
    if (cdataEnd < 0) return null;
    text += source.slice(offset, cdataEnd);
    offset = cdataEnd + 3;
    if (!source.startsWith('<![CDATA[', offset)) break;
    offset += '<![CDATA['.length;
  }

  offset = skipWhitespace(source, offset);
  const closeTag = `</${tag}>`;
  if (!source.startsWith(closeTag, offset)) return null;
  return { text, offset: offset + closeTag.length };
}

function skipWhitespace(source: string, offset: number) {
  while (offset < source.length && /\s/.test(source[offset] ?? '')) {
    offset += 1;
  }
  return offset;
}

function normalizeBriefingText(value: string | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

function isGuardDecisionCustomData(data: Record<string, unknown>): boolean {
  return data.name === GUARD_DECISION_EVENT || data.name === SUBAGENT_GUARD_DECISION_EVENT;
}

export type RootStreamAdapterOptions = {
  /**
   * Assistant-reply node filter for depth-1 message activity. Defaults to the
   * production orchestrator contract: only `answer` is user-facing. Internal
   * nodes can write synthetic AI messages such as delegation briefings, which
   * stay observable on the raw stream without becoming chat output.
   */
  isMainAssistantNode?: (node: string | null) => boolean;
};

function defaultIsMainAssistantNode(node: string | null): boolean {
  if (node === null) {
    return true;
  }
  return MAIN_ASSISTANT_NODE_NAMES.has(node);
}

function isInternalOrchestratorNamespace(namespace: string[]) {
  const node = readNamespaceNode(namespace);
  return node !== null && isOrchestratorInternalAiStreamNode(node);
}

/**
 * Per-namespace lifecycle tracking: `content-block-delta` events carry no
 * message id — within one namespace they belong to the message opened by the
 * most recent `message-start` there. Subagent lifecycles additionally buffer
 * their text so the message can be emitted whole on `message-finish`.
 */
type MessageLifecycle = {
  messageId: string;
  role: string;
  buffer: string;
  lastEmitted: string;
};

export type RootStreamAdapterState = Map<string, MessageLifecycle>;

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
      // Internal decision and Planner Agent model activity remains observable
      // on the raw protocol stream, but it is not assistant output or
      // delegated-subagent progress. This also covers the Planner's nested
      // private tool loop (namespace depth >= 2).
      if (isInternalOrchestratorNamespace(namespace)) {
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
          const briefing = parseDelegationBriefing(message);
          if (briefing) {
            return {
              type: 'delegation.briefing',
              namespace,
              messageId: current.messageId || `${key}:${event.seq}`,
              briefing,
            };
          }
          return {
            type: 'subagent.message',
            namespace,
            messageId: current.messageId || `${key}:${event.seq}`,
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
      // Planner file exploration tools are framework internals, not Capability
      // Toolkit activity exposed to the chat surface.
      if (isInternalOrchestratorNamespace(namespace)) {
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
        return {
          type: 'runtime.custom',
          streamSequence: event.seq,
          name: data.name,
          data: data.data,
        };
      }
      return {
        type: 'runtime.custom',
        streamSequence: event.seq,
        name: 'unknown',
        data: data.payload ?? data,
      };
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
