import { dispatchCustomEvent } from '@langchain/core/callbacks/dispatch';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { GuardDecisionEmitter } from '../../../../guards';

/**
 * Custom-event name for orchestrator guard decision records. Records flow
 * into the LangGraph event stream (`on_custom_event`) and the LangSmith trace;
 * consumers filter by this name.
 */
export const GUARD_DECISION_EVENT = 'pinpawo_guard_decision';

/**
 * Emitter for orchestrator node positions. Emission is advisory: without a
 * runnable config (e.g. direct node unit tests) or outside a run context it
 * degrades to a no-op — a decision record must never fail the decision.
 */
export function guardDecisionEmitter(runnableConfig?: RunnableConfig): GuardDecisionEmitter {
  return (record) => {
    if (!runnableConfig) {
      return;
    }
    try {
      void dispatchCustomEvent(GUARD_DECISION_EVENT, record, runnableConfig).catch(() => {});
    } catch {
      // Outside a parent run context; skip.
    }
  };
}
