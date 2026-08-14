import type { OrchestratorStateType } from './state';

/**
 * Orchestrator control-flow primitives.
 *
 * Guard rules live in `agent/orchestrator/guardDefinitions` and are evaluated
 * by their owning positions via `evaluateGuard` (see docs/reference/runtime/guards.md).
 * This module keeps the remaining graph-local primitives: state patches and
 * recursion limits.
 */

/** A patch returned by a guard/decision; merged into orchestrator state by the graph. */
export type OrchestratorStatePatch = Partial<OrchestratorStateType>;

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
