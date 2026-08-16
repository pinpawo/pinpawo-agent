import { SystemMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Command, Send } from '@langchain/langgraph';
import type { CapabilityPlannerDispatch } from '../../capabilityPlanner/runner';
import { USER_GOAL_MAX_CHARS } from '../../capabilityPlanner/runner';
import { mainConversationMessages } from '../../messageLanes';
import { buildGoalCreationSystemPrompt } from '../../prompts';
import type { OrchestratorStateType } from '../../state';
import type { OrchestratorConfig, UserGoal } from '../../types';
import { readMessageText } from '../../utils';

export function createGoalCreationRunner(config: OrchestratorConfig) {
  return async function runGoalCreation(
    state: OrchestratorStateType,
    runnableConfig?: RunnableConfig,
  ) {
    const messages = buildGoalCreationMessages({ state });
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
  state: OrchestratorStateType;
}) {
  const { state } = params;
  const mainMessages = mainConversationMessages(state.messages)
    .filter((message) => message._getType() === 'human' || message._getType() === 'ai');
  let currentRequestIndex = -1;
  for (let index = mainMessages.length - 1; index >= 0; index -= 1) {
    if (mainMessages[index]?._getType() === 'human') {
      currentRequestIndex = index;
      break;
    }
  }
  const currentRequest = mainMessages[currentRequestIndex];
  if (!currentRequest) {
    throw new Error('Goal Creation requires a current HumanMessage.');
  }
  const conversationHistory = mainMessages.filter((_, index) => index !== currentRequestIndex);
  return [
    new SystemMessage(buildGoalCreationSystemPrompt()),
    ...conversationHistory,
    currentRequest,
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
