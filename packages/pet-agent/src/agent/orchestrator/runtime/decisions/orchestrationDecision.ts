import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Command, Send } from '@langchain/langgraph';
import type { CapabilityPlannerDispatch } from '../../capabilityPlanner/runner';
import { USER_GOAL_MAX_CHARS } from '../../capabilityPlanner/runner';
import { readContextCompactionSummaries } from '../../contextCompaction';
import { setPinpetMeta } from '../../messageLanes';
import {
  buildCompactionSummaryXmlContext,
  buildGoalCreationInput,
  buildGoalCreationSystemPrompt,
  buildRunDelegationSummaryContext,
  buildRuntimeContext,
} from '../../prompts';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig, UserGoal } from '../../types';
import { readMessageText } from '../../utils';
import {
  getInvokeOptions,
  resolveActor,
} from '../config';
import { mainMessagesWithoutCompaction } from './conversationContext';

export function createGoalCreationRunner(config: OrchestratorConfig) {
  return async function runGoalCreation(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const messages = buildGoalCreationMessages({ config, state, runnableConfig });
    const response = await (config.models.decision ?? config.models.act).invoke(
      messages,
      runnableConfig,
    );
    const userGoal = readUserGoalText(response);
    const dispatch: CapabilityPlannerDispatch = {
      mode: 'entry',
      plannerState: {
        runId: state.runId,
        traceId: state.traceId,
        runUserGoal: userGoal,
        runDelegationSummaries: state.runDelegationSummaries,
        runCapabilityPlan: [],
      },
    };
    return new Command({
      update: {
        runNextDelegation: null,
        runCapabilityPlan: [],
        runUserGoal: userGoal,
      },
      goto: new Send('capabilityPlanner', dispatch),
    });
  };
}

function buildGoalCreationMessages(params: {
  config: OrchestratorConfig;
  state: OrchestratorStateType;
  runnableConfig?: RunnableConfig;
}) {
  const { config, state, runnableConfig } = params;
  const { workdir, runtimeEnvironment } = getInvokeOptions(runnableConfig);
  const actor = resolveActor(config, runnableConfig);
  const contextSummaries = readContextCompactionSummaries(state.messages);
  const compactionContext = buildCompactionSummaryXmlContext(contextSummaries);
  const conversationMessages = [
    ...(compactionContext ? [new AIMessage(compactionContext)] : []),
    ...mainMessagesWithoutCompaction(state.messages)
      .filter((message) => message._getType() === 'human' || message._getType() === 'ai'),
  ];
  const contextMessage = new HumanMessage(buildGoalCreationInput({
    runDelegationContext: buildRunDelegationSummaryContext(state.runDelegationSummaries),
    runtimeContext: buildRuntimeContext(workdir, runtimeEnvironment),
  }));
  setPinpetMeta(contextMessage, {
    source: 'goal_creation_context',
    synthetic: true,
  });
  return [
    new SystemMessage(buildGoalCreationSystemPrompt(actor)),
    contextMessage,
    ...conversationMessages,
  ];
}

export function readUserGoalText(value: { content?: unknown }): UserGoal {
  const text = readMessageText(value).trim();
  if (!text) {
    throw new Error('Goal Creation requires a non-empty text response.');
  }
  if (text.length > USER_GOAL_MAX_CHARS) {
    throw new Error(
      `Goal Creation response exceeds ${String(USER_GOAL_MAX_CHARS)} characters.`,
    );
  }
  return text;
}
