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
import { afterPrepare } from '../routes/afterPrepare';

export function createPrepareNode() {
  return async function prepare(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    const outcome = evaluateGuard(runStateResetGuard, {
      state,
      config: {},
      position: ORCHESTRATOR_GUARD_POSITION.PREPARE,
    }, { emit: guardDecisionEmitter(runnableConfig), runId: state.runId });
    const freshMessages = state.messages.filter((message) => HumanMessage.isInstance(message)
      && !getAgentMessageLane(message) && getAgentMessageRunId(message) === state.runId);
    const update: Partial<OrchestratorStateType> = outcome.kind === 'derive' ? buildRunStateReset() : {};
    const traceId = update.traceId ?? state.traceId;
    const messages = freshMessages.map((message) =>
      setAgentMessageMetadata(new HumanMessage({ ...message }), { traceId }));
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
        preserveExecutionTaskIds: state.runSupervisorState.plan
          .filter((task) => task.status !== 'completed' && task.status !== 'superseded').map((task) => task.id),
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
