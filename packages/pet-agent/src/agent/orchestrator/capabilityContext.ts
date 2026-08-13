import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { buildRunUserGoalContext } from './prompts/context';
import type { UserGoal } from './types';
import { getPinpetMeta, setPinpetMeta } from './messageLanes';
import { insertBeforeLatestDelegationBriefing } from './delegationBriefing';

export const RUN_USER_GOAL_CONTEXT_SOURCE = 'run_user_goal_context';

export function buildRunUserGoalContextMessage(userGoal: UserGoal): AIMessage {
  const message = new AIMessage(buildRunUserGoalContext(userGoal));
  setPinpetMeta(message, {
    source: RUN_USER_GOAL_CONTEXT_SOURCE,
    synthetic: true,
  });
  return message;
}

/**
 * Project the stable run goal into one Capability invocation without writing it
 * back to root or lane history. Keep the latest delegation briefing last so it
 * remains the immediate execution boundary for both initial and resumed work.
 */
export function withRunUserGoalContext(
  messages: BaseMessage[],
  userGoal: UserGoal,
): BaseMessage[] {
  const baseMessages = messages.filter((message) =>
    getPinpetMeta(message).source !== RUN_USER_GOAL_CONTEXT_SOURCE);
  const contextMessage = buildRunUserGoalContextMessage(userGoal);
  return insertBeforeLatestDelegationBriefing(baseMessages, contextMessage);
}
