import { type BaseMessage } from '@langchain/core/messages';
import {
  createGuardRunner,
  type GuardRunOptions,
  type GuardRunnerAdapter,
  type GuardCheckResult,
} from '../guards';
import {
  createSubagentGuardRegistry,
  type SubagentGuardConfig,
  type SubagentGuardPosition,
  type SubagentGuardRegistry,
  type SubagentGuardUpdate,
  type SubagentState,
} from './guardDefinitions';
import type { SubagentInputState } from '../types/subagent';

function snapshotSubagentStateForMiddleware(
  inputState: SubagentInputState,
  messages: BaseMessage[],
  iterationCount: number,
  maxIterations: number,
): SubagentState {
  return {
    ...inputState,
    iterationCount,
    maxIterations,
    messages,
  };
}

type SubagentMiddlewareGuardRunArgs = {
  name: string;
  position: SubagentGuardPosition;
  messages: BaseMessage[];
  iterationCount: number;
  runOptions?: GuardRunOptions<
    SubagentState,
    SubagentGuardConfig,
    SubagentGuardPosition,
    SubagentGuardUpdate
  >;
};

type SubagentMiddlewareGuardRunResult = {
  result: GuardCheckResult;
  update: SubagentGuardUpdate | null;
};

export type SubagentMiddlewareGuardRunner = (args: SubagentMiddlewareGuardRunArgs) => Promise<SubagentMiddlewareGuardRunResult>;

/**
 * Create a shared middleware guard runner for the subagent.
 *
 * The runner wraps `registry.run` with an adapter that snapshots the
 * hook-local `messages` and `iterationCount` into a `SubagentState` before
 * calling the guard registry. The same runner instance — and the same
 * underlying registry — should be shared by all subagent middleware
 * (context policy + iteration guard) so that:
 *
 * 1. The registry is created once per subagent runtime scope (not per
 *    middleware), matching the design doc's "once per runtime/graph scope"
 *    contract.
 * 2. `iterationCount` is shared between middleware, avoiding implicit
 *    dependence on LangChain middleware execution order.
 */
export function createSubagentMiddlewareGuardRunner(params: {
  inputState: SubagentInputState;
  maxIterations: number;
  registry?: SubagentGuardRegistry;
}): SubagentMiddlewareGuardRunner {
  const registry = params.registry ?? createSubagentGuardRegistry();

  const adapter: GuardRunnerAdapter<
    SubagentState,
    SubagentGuardConfig,
    SubagentGuardPosition,
    SubagentGuardUpdate
  > = {
    resolveGuardInput: ({ state, position }) => ({
      state,
      config: {} as SubagentGuardConfig,
      position,
    }),
    applyResult: ({ result }) => result.update ?? null,
  };

  const runGuard = createGuardRunner({
    registry,
    adapter,
  });

  return async function runSubagentMiddlewareGuard(args: SubagentMiddlewareGuardRunArgs): Promise<SubagentMiddlewareGuardRunResult> {
    const state = snapshotSubagentStateForMiddleware(
      params.inputState,
      args.messages,
      args.iterationCount,
      params.maxIterations,
    );

    return runGuard({
      name: args.name,
      position: args.position,
      state,
      runOptions: args.runOptions,
    });
  };
}
