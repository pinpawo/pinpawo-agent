import type { RunnableConfig } from '@langchain/core/runnables';
import { compactOrchestratorMessages } from '../../contextCompaction';
import type { OrchestratorStatePatch } from '../../controlPrimitives';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
} from '../../guardDefinitions';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { recoverTaskActiveDelegationFromRunState } from '../decisions/delegationLifecycle';
import type { OrchestratorGuardRunner } from '../guards/runner';

export function createPrepareNode(runOrchestratorGuard: OrchestratorGuardRunner) {
  return async function prepare(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const patch = await runOrchestratorGuard(
      ORCHESTRATOR_GUARD_NAME.RUN_STATE_RESET,
      ORCHESTRATOR_GUARD_POSITION.PREPARE,
      state,
      runnableConfig,
    );
    if ('runId' in patch) {
      return patch;
    }
    const taskActiveDelegation = recoverTaskActiveDelegationFromRunState(state);
    return taskActiveDelegation
      ? { ...patch, taskActiveDelegation }
      : patch;
  };
}

export function createCompactContextNode(params: {
  config: OrchestratorConfig;
  runOrchestratorGuard: OrchestratorGuardRunner;
}) {
  return async function compactContext(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    return params.runOrchestratorGuard(
      ORCHESTRATOR_GUARD_NAME.CONTEXT_COMPACTION_WATERMARK,
      ORCHESTRATOR_GUARD_POSITION.CONTEXT_COMPACTION,
      state,
      runnableConfig,
      {
        onBlock: async ({ state: blockedState }) => {
          const compacted = await compactOrchestratorMessages({
            messages: blockedState.messages,
            model: params.config.models.observe ?? params.config.models.act,
            runnableConfig,
          });
          if (!compacted.compacted) {
            return {};
          }
          return {
            messages: compacted.messages,
          };
        },
      },
    );
  };
}

export function prepareUserIntentDecision(): OrchestratorStatePatch {
  return {
    canHandoffActiveDelegation: true,
  };
}
