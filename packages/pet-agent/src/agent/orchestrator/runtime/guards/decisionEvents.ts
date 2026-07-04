import { dispatchCustomEvent } from '@langchain/core/callbacks/dispatch';
import type { RunnableConfig } from '@langchain/core/runnables';
import type {
  GuardDecisionEmitter,
  GuardDecisionRecord,
} from '../../../../guards';

/**
 * Event name for orchestrator guard decision records; consumers filter by it
 * on both channels below.
 */
export const GUARD_DECISION_EVENT = 'pinpawo_guard_decision';

/**
 * The chunk shape guard decision records use on the LangGraph custom stream.
 * Mirrors the subagent runtime-event shape so consumers share one filtering
 * convention: `{ event: 'on_runtime_event', name, data }`.
 */
export type GuardDecisionStreamChunk = {
  event: 'on_runtime_event';
  name: typeof GUARD_DECISION_EVENT;
  data: GuardDecisionRecord;
};

export function isGuardDecisionStreamChunk(chunk: unknown): chunk is GuardDecisionStreamChunk {
  return Boolean(
    chunk
    && typeof chunk === 'object'
    && (chunk as { event?: unknown }).event === 'on_runtime_event'
    && (chunk as { name?: unknown }).name === GUARD_DECISION_EVENT,
  );
}

type WriterCapableConfig = RunnableConfig & {
  writer?: (chunk: unknown) => void;
};

/**
 * Emitter for orchestrator node positions. Records go to two channels:
 *
 * - the LangGraph custom stream (`streamMode: 'custom'`, via the node
 *   config's `writer`) — this is how records surface as root custom protocol
 *   events for local-agent stream consumers;
 * - `dispatchCustomEvent` — this is how records reach LangGraph
 *   `streamEvents` (`on_custom_event`) consumers and the LangSmith trace.
 *
 * Emission is advisory: without a runnable config (e.g. direct node unit
 * tests) or outside a run context it degrades to a no-op — a decision record
 * must never fail the decision.
 */
export function guardDecisionEmitter(runnableConfig?: RunnableConfig): GuardDecisionEmitter {
  return (record) => {
    if (!runnableConfig) {
      return;
    }
    const chunk: GuardDecisionStreamChunk = {
      event: 'on_runtime_event',
      name: GUARD_DECISION_EVENT,
      data: record,
    };
    try {
      (runnableConfig as WriterCapableConfig).writer?.(chunk);
    } catch {
      // Stream writer unavailable; skip.
    }
    try {
      void dispatchCustomEvent(GUARD_DECISION_EVENT, record, runnableConfig).catch(() => {});
    } catch {
      // Outside a parent run context; skip.
    }
  };
}
