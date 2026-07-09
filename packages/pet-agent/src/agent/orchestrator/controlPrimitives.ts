import type { RunnableConfig } from '@langchain/core/runnables';
import { Command } from '@langchain/langgraph';
import type { OrchestratorStateType } from './state';

/**
 * Orchestrator control-flow primitives.
 *
 * Guard rules live in `agent/orchestrator/guardDefinitions` and are evaluated
 * by their owning positions via `evaluateGuard` (see docs/GUARD_DESIGN.md).
 * This module keeps the remaining graph-local primitives: state patches,
 * recursion limits, and Decision node adaptation.
 */

/** A patch returned by a guard/decision; merged into orchestrator state by the graph. */
export type OrchestratorStatePatch = Partial<OrchestratorStateType>;
export type OrchestratorNodeResult = OrchestratorStatePatch | Command;

/**
 * The orchestrator graph's hard `recursionLimit` — a last-resort breaker for a
 * runaway control loop (e.g. a decision that keeps delegating), NOT the normal
 * stop. The normal stop is the soft `runIterationLimitGuard`, which ends the run
 * gracefully (records the delegation as 待续跑, resets, routes to END) when the
 * per-run delegation count is reached.
 *
 * So this only has to be comfortably larger than what a healthy run consumes:
 * the soft guard's default of 25 delegations, each walking a handful of graph
 * nodes, lands around ~100 nodes; 200 leaves ample headroom so normal
 * conversations never trip it while still bounding a genuine loop. A flat value
 * is intentional — there is no need to track the exact node-per-delegation count.
 */
export const ORCHESTRATOR_RECURSION_LIMIT = 200;

/** Shared context handed to every guard/decision (run-scoped config + derived limits). */
export type OrchestratorControlContext = {
  runnableConfig?: RunnableConfig;
  /** Effective per-run delegation limit for this graph (config ?? default). */
  orchestratorMaxIterations: number;
};

/** Route chooser (may use an LLM). Input state → state patch. */
export type OrchestratorDecision = (
  state: OrchestratorStateType,
  ctx: OrchestratorControlContext,
) => Promise<OrchestratorNodeResult>;

/** The node signature LangGraph invokes. */
export type OrchestratorNode = (
  state: OrchestratorStateType,
  runnableConfig?: RunnableConfig,
) => OrchestratorNodeResult | Promise<OrchestratorNodeResult>;

export function createControlContextBuilder(orchestratorMaxIterations: number) {
  return function buildControlContext(runnableConfig?: RunnableConfig): OrchestratorControlContext {
    return { runnableConfig, orchestratorMaxIterations };
  };
}

export function asDecisionNode(
  decision: OrchestratorDecision,
  buildContext: (runnableConfig?: RunnableConfig) => OrchestratorControlContext,
): OrchestratorNode {
  return (state, runnableConfig) => decision(state, buildContext(runnableConfig));
}

export function commandTo(goto: string, update?: OrchestratorStatePatch): Command {
  return new Command({
    goto,
    ...(update ? { update: update as Record<string, unknown> } : {}),
  });
}
