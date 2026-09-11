import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { getAgentMessageLane, getAgentMessageRunId, setAgentMessageMetadata } from '../../../messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { evaluateGuard } from '../../../../guards';
import { compactOrchestratorMessages } from '../../contextCompaction';
import {
  contextCompactionWatermarkGuard,
  ORCHESTRATOR_GUARD_POSITION,
} from '../../guardDefinitions';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig } from '../../types';
import { guardDecisionEmitter } from '../guards/decisionEvents';
import { afterPrepare } from '../routes/afterPrepare';

export function createPrepareNode() {
  return async function prepare(state: OrchestratorStateType, runnableConfig?: RunnableConfig) {
    if (!state.runId || !state.traceId) {
      throw new Error('Fresh runs must be initialized with buildOrchestratorRunInput.');
    }
    const freshMessages = state.messages.filter((message) => HumanMessage.isInstance(message)
      && !getAgentMessageLane(message) && getAgentMessageRunId(message) === state.runId);
    if (!freshMessages.length) throw new Error('Fresh run requires a HumanMessage bound to its runId.');
    const traceId = state.traceId;
    const messages = freshMessages.map((message) =>
      setAgentMessageMetadata(new HumanMessage({ ...message }), { traceId }));
    return new Command({ update: { messages }, goto: afterPrepare(state) });
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
