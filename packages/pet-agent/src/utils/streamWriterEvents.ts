import { getWriter } from '@langchain/langgraph';
import type { SubagentRuntimeEvent } from '../types/subagent';

/**
 * Writes a runtime event through the run's stream writer. Pregel injects the
 * writer with `config.writer ??= ...`, so anything executing inside the graph
 * (nodes, toolkit middleware, a subagent invoked with the parent config)
 * writes through the ROOT run's writer and the event surfaces as a `custom`
 * protocol event on `streamEvents(v3)` (#322). Emission is advisory: outside
 * a run context it degrades to a no-op — a runtime event must never fail the
 * work that emitted it.
 */
export function emitRuntimeEventToStreamWriter(event: SubagentRuntimeEvent) {
  try {
    getWriter()?.(event);
  } catch {
    // Outside a run context; skip.
  }
}
