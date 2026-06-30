import type { BaseMessage } from '@langchain/core/messages';
import {
  createGuardRunner,
  type GuardRunOptions,
  type GuardRunResult,
} from '../guards';
import type { SubagentInputState } from '../types/subagent';
import {
  createSubagentGuardRegistry,
  type SubagentGuardConfig,
  type SubagentGuardName,
  type SubagentGuardPosition,
  type SubagentGuardUpdate,
  type SubagentState,
} from './guardDefinitions';

export type SubagentMiddlewareGuardRunOptions = GuardRunOptions<
  SubagentState,
  SubagentGuardConfig,
  SubagentGuardPosition,
  SubagentGuardUpdate
>;

export type SubagentMiddlewareGuardRuntimeInput = {
  messages: BaseMessage[];
  iterationCount: number;
};

export type SubagentMiddlewareGuardRunner = (
  name: SubagentGuardName,
  position: SubagentGuardPosition,
  input: SubagentMiddlewareGuardRuntimeInput,
  runOptions?: SubagentMiddlewareGuardRunOptions,
) => Promise<GuardRunResult<SubagentGuardUpdate>>;

function snapshotSubagentStateForMiddleware(params: {
  inputState: SubagentInputState;
  messages: BaseMessage[];
  iterationCount: number;
  maxIterations: number;
}): SubagentState {
  return {
    ...params.inputState,
    iterationCount: params.iterationCount,
    maxIterations: params.maxIterations,
    messages: params.messages,
  };
}

export function createSubagentMiddlewareGuardRunner(params: {
  inputState: SubagentInputState;
  maxIterations: number;
}): SubagentMiddlewareGuardRunner {
  return createGuardRunner<
    SubagentGuardName,
    SubagentState,
    SubagentGuardConfig,
    SubagentGuardPosition,
    SubagentGuardUpdate,
    SubagentMiddlewareGuardRuntimeInput
  >({
    registry: createSubagentGuardRegistry(),
    adapter: {
      toGuardInput: (position, input) => ({
        state: snapshotSubagentStateForMiddleware({
          inputState: params.inputState,
          messages: input.messages,
          iterationCount: input.iterationCount,
          maxIterations: params.maxIterations,
        }),
        config: {
          contextWindowTokens: params.inputState.contextWindowTokens,
        },
        position,
      }),
    },
  });
}
