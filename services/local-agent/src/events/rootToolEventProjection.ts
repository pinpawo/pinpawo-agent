import { SubagentProtocolToolEventReader } from '@pinpawo/pet-agent';
import type { LocalAgentOperationInternalEvent } from './localAgentEvent';
import {
  normalizeToolStreamEvent,
  type StreamToolsPayload,
} from './agentStreamNormalizer';
import {
  emptyOperationRegistry,
  type OperationRegistry,
} from './operationRegistry';
import { namespaceKey, type RootStreamChatEvent } from './rootStreamEventAdapter';

/**
 * Operation-metadata projection for root-stream tool events (#322 Phase 3).
 *
 * Root protocol `tools` events only carry `tool_call_id`/`tool_name` (and the
 * name only on `tool-started`). The TUI's operation timeline needs display
 * metadata — title, target, summarized input/output — which lives in the
 * operation registry built from the setup's toolkits. This projection joins
 * the two:
 *
 *   adapter `tool` event
 *     → SubagentProtocolToolEventReader (name memory, started/finished dedup,
 *       serialized-interrupt swallowing — shared with the legacy bridge)
 *     → normalizeToolStreamEvent + OperationRegistry (title/target/summary)
 *     → LocalAgentOperationInternalEvent
 *
 * One projection instance per run, one reader per namespace: the reader's
 * dedup/name memory is keyed by raw `tool_call_id`, and call ids are only
 * unique within the scope that produced them — two scopes reusing an id must
 * not share dedup state, or the second `tool-started` is dropped and the name
 * memory overwritten. The event's namespace is preserved on the result for
 * scope attribution (main vs subagent lane).
 */

export type RootOperationProjection = {
  operation: LocalAgentOperationInternalEvent;
  namespace: string[];
};

export type RootToolEventProjector = (
  toolEvent: Extract<RootStreamChatEvent, { type: 'tool' }>,
) => RootOperationProjection | null;

export function createRootToolEventProjector(params: {
  requestId: string;
  registry?: OperationRegistry;
}): RootToolEventProjector {
  const readers = new Map<string, SubagentProtocolToolEventReader>();
  const registry = params.registry ?? emptyOperationRegistry;

  return function projectRootToolEvent(toolEvent) {
    const key = namespaceKey(toolEvent.namespace);
    let reader = readers.get(key);
    if (!reader) {
      reader = new SubagentProtocolToolEventReader();
      readers.set(key, reader);
    }
    const lifecycle = reader.readToolsData(toolEvent.data);
    if (!lifecycle) {
      return null;
    }
    return {
      operation: normalizeToolStreamEvent(
        params.requestId,
        lifecycle as StreamToolsPayload,
        registry,
      ),
      namespace: toolEvent.namespace,
    };
  };
}
