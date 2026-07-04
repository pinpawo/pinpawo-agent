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

/**
 * Captures the CURRENT context's stream writer and returns an emitter bound
 * to it. `getWriter()` resolves through AsyncLocalStorage, which does not
 * reach tool-execution scopes inside a child agent (the same tool boundary as
 * #322 Caveat 1) — a toolkit review middleware emitting from inside a wrapped
 * tool would find no writer. Capturing at node time and closing over the
 * writer keeps those emissions flowing to the root stream.
 */
export function createRuntimeEventStreamEmitter(): (event: SubagentRuntimeEvent) => void {
  let writer: ReturnType<typeof getWriter>;
  try {
    writer = getWriter();
  } catch {
    writer = undefined;
  }
  return (event) => {
    try {
      writer?.(event);
    } catch {
      // Never fail the emitting work.
    }
  };
}
