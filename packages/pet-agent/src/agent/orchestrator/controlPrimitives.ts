import type { RunnableConfig } from '@langchain/core/runnables';
import type { OrchestratorStateType } from './state';

/**
 * Orchestrator control-flow abstractions — the code form of the Decision/Guard
 * split the orchestrator graph already used by naming convention only.
 *
 * - **Guard**: a hard, deterministic pass/block check (no LLM). Input state →
 *   a state patch. "Pass" returns a neutral/clearing patch; "block" returns a
 *   patch that routes the run to a stop / fallback. Examples:
 *   `runIterationLimitGuard` (run delegation count reached),
 *   `delegationOutcomeDecisionGuard` (whether the active delegation may hand off).
 * - **Decision**: chooses among legal next routes, and *may* use an LLM /
 *   structured output. Example: `runOrchestrationDecision`.
 *
 * Both are position-independent `(state, ctx) => patch` contracts; a graph node
 * is just one place they are invoked. The node adapters below translate a
 * Guard/Decision into the `(state, runnableConfig?)` node signature LangGraph
 * expects, so the graph wiring reads as `asGuardNode(...)` / `asDecisionNode(...)`
 * instead of bare async closures.
 *
 * Scope (P5 / #281): this is the orchestrator-domain contract. The subagent loop
 * has its own domain contract (`SubagentLoopGuard`, over messages/tokens); they
 * share the Decision/Guard *concept* but not a single interface, by design.
 * See docs/SUBAGENT_LIMIT_FRAMEWORK_DESIGN.md §4.
 */

/** A patch returned by a guard/decision; merged into orchestrator state by the graph. */
export type OrchestratorStatePatch = Partial<OrchestratorStateType>;

/** Shared context handed to every guard/decision (run-scoped config + derived limits). */
export type OrchestratorControlContext = {
  runnableConfig?: RunnableConfig;
  /** Effective per-run delegation limit for this graph (config ?? default). */
  orchestratorMaxIterations: number;
};

/** Deterministic pass/block check (no LLM). Input state → state patch. */
export type OrchestratorGuard = (
  state: OrchestratorStateType,
  ctx: OrchestratorControlContext,
) => OrchestratorStatePatch | Promise<OrchestratorStatePatch>;

/** Route chooser (may use an LLM). Input state → state patch. */
export type OrchestratorDecision = (
  state: OrchestratorStateType,
  ctx: OrchestratorControlContext,
) => Promise<OrchestratorStatePatch>;

/** The node signature LangGraph invokes. */
export type OrchestratorNode = (
  state: OrchestratorStateType,
  runnableConfig?: RunnableConfig,
) => OrchestratorStatePatch | Promise<OrchestratorStatePatch>;

/**
 * Adapts a Guard into a graph node, supplying the shared control context. The
 * same adapter shape serves Decisions (`asDecisionNode`) — the distinction is in
 * the contract type, not the wiring, which keeps `Node -> Guard` and
 * `Node -> Decision` symmetric.
 */
export function asGuardNode(
  guard: OrchestratorGuard,
  buildContext: (runnableConfig?: RunnableConfig) => OrchestratorControlContext,
): OrchestratorNode {
  return (state, runnableConfig) => guard(state, buildContext(runnableConfig));
}

export function asDecisionNode(
  decision: OrchestratorDecision,
  buildContext: (runnableConfig?: RunnableConfig) => OrchestratorControlContext,
): OrchestratorNode {
  return (state, runnableConfig) => decision(state, buildContext(runnableConfig));
}
