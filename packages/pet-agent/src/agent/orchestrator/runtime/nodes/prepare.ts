import type { RunnableConfig } from '@langchain/core/runnables';
import { RemoveMessage } from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import { evaluateGuard } from '../../../../guards';
import { compactOrchestratorMessages } from '../../contextCompaction';
import {
  contextCompactionWatermarkGuard,
  ORCHESTRATOR_GUARD_POSITION,
  runStateResetGuard,
} from '../../guardDefinitions';
import { buildRunStateReset } from '../../state';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { guardDecisionEmitter } from '../guards/decisionEvents';
import { applyActiveDelegationTransition } from '../activeDelegationTransition';
import { findCanonicalSystemMessage } from '../../../messages';

export function createPrepareNode() {
  return async function prepare(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    if (findCanonicalSystemMessage(state.messages)) {
      return {
        // Old checkpoints used canonical SystemMessages as an instruction
        // channel. Do not migrate or retain that authority: discard the whole
        // legacy history before reporting the incompatibility.
        messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES })],
        runNextDelegation: null,
        runPlannerSession: null,
        taskPlannerContinuation: null,
        runLatestDelegationOutcome: null,
        runRuntimeFailure: 'checkpoint_incompatible' as const,
      };
    }
    const outcome = evaluateGuard(runStateResetGuard, {
      state,
      config: {},
      position: ORCHESTRATOR_GUARD_POSITION.PREPARE,
    }, { emit: guardDecisionEmitter(runnableConfig), runId: state.runId });
    if (outcome.kind === 'derive') {
      return buildRunStateReset();
    }
    return applyActiveDelegationTransition(state);
  };
}

export function createCompactContextNode(params: {
  config: OrchestratorConfig;
}) {
  return async function compactContext(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const outcome = evaluateGuard(contextCompactionWatermarkGuard, {
      state,
      config: {
        contextWindowTokens: params.config.contextWindowTokens,
        generationReserveTokens: params.config.generationReserveTokens,
      },
      position: ORCHESTRATOR_GUARD_POSITION.CONTEXT_COMPACTION,
    }, { emit: guardDecisionEmitter(runnableConfig), runId: state.runId });
    if (outcome.kind !== 'maintain') {
      return {};
    }
    const compacted = await compactOrchestratorMessages({
      messages: state.messages,
      model: params.config.models.observe ?? params.config.models.act,
      ...(state.taskActiveDelegation ? {
        options: {
          preserveAnnouncesFor: {
            lane: state.taskActiveDelegation.lane,
            runId: state.taskActiveDelegation.runId,
            delegationId: state.taskActiveDelegation.id,
          },
        },
      } : {}),
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
