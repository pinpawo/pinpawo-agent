import type { RunnableConfig } from '@langchain/core/runnables';
import { evaluateGuard } from '../../../../guards';
import { compactOrchestratorMessages } from '../../contextCompaction';
import type { OrchestratorStatePatch } from '../../controlPrimitives';
import {
  contextCompactionWatermarkGuard,
  ORCHESTRATOR_GUARD_POSITION,
  runStateResetGuard,
} from '../../guardDefinitions';
import { buildRunStateReset } from '../../state';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { recoverTaskActiveDelegationFromRunState } from '../decisions/delegationLifecycle';

export function createPrepareNode() {
  return async function prepare(state: OrchestratorStateType, _runnableConfig?: RunnableConfig) {
    const outcome = evaluateGuard(runStateResetGuard, {
      state,
      config: {},
      position: ORCHESTRATOR_GUARD_POSITION.PREPARE,
    });
    if (outcome.kind === 'derive') {
      return buildRunStateReset();
    }
    const taskActiveDelegation = recoverTaskActiveDelegationFromRunState(state);
    return taskActiveDelegation ? { taskActiveDelegation } : {};
  };
}

export function createCompactContextNode(params: {
  config: OrchestratorConfig;
}) {
  return async function compactContext(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const outcome = evaluateGuard(contextCompactionWatermarkGuard, {
      state,
      config: { contextWindowTokens: params.config.contextWindowTokens },
      position: ORCHESTRATOR_GUARD_POSITION.CONTEXT_COMPACTION,
    });
    if (outcome.kind !== 'maintain') {
      return {};
    }
    const compacted = await compactOrchestratorMessages({
      messages: state.messages,
      model: params.config.models.observe ?? params.config.models.act,
      runnableConfig,
    });
    if (!compacted.compacted) {
      return {};
    }
    return {
      messages: compacted.messages,
    };
  };
}

export function prepareUserIntentDecision(): OrchestratorStatePatch {
  return {
    canHandoffActiveDelegation: true,
  };
}
