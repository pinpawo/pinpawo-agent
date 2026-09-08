import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { getAgentMessageLane, getAgentMessageRunId, setAgentMessageMetadata } from '../../../messages';
import type { RunnableConfig } from '@langchain/core/runnables';
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
import { afterPrepare } from '../routes/afterPrepare';

export function createPrepareNode() {
  return async function prepare(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const outcome = evaluateGuard(runStateResetGuard, {
      state,
      config: {},
      position: ORCHESTRATOR_GUARD_POSITION.PREPARE,
    }, { emit: guardDecisionEmitter(runnableConfig), runId: state.runId });
    const update = outcome.kind === 'derive'
      ? buildRunStateReset() : applyActiveDelegationTransition(state);
    const traceId = update.traceId ?? state.traceId;
    // Resolve resume identity before stamping the fresh user supplement. Never
    // retag older conversation turns or Capability-private messages.
    const messages = state.messages.filter((message) => HumanMessage.isInstance(message)
      && !getAgentMessageLane(message) && getAgentMessageRunId(message) === state.runId)
      .map((message) => setAgentMessageMetadata(new HumanMessage({ ...message }), { traceId }));
    if (state.taskPauseInterrupt && state.runActiveDelegationTransition === 'resume_active') {
      // A legacy continue request over a real pause mirrors pauseGate resume:
      // apply guidance to the same delegation, without a new Supervisor decision.
      const resumed = { ...state, ...update };
      return new Command({
        update: { ...update, messages, taskPauseInterrupt: null },
        goto: resumed.runNextDelegation?.id === resumed.taskActiveDelegation?.id
          && resumed.runNextDelegation ? 'capability' : 'answer',
      });
    }
    return new Command({ update: { ...update, messages }, goto: afterPrepare({ ...state, ...update }) });
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
      options: {
        traceId: state.traceId,
        ...(state.taskActiveDelegation ? { preserveAnnouncesFor: {
          lane: state.taskActiveDelegation.lane,
          runId: state.taskActiveDelegation.runId,
          delegationId: state.taskActiveDelegation.id,
        } } : {}),
      },
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
