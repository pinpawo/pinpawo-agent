import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { buildRunUserRequestContext } from './prompts/context';
import type { UserRequest } from './types';
import { getPinpetMeta, setPinpetMeta } from './messageLanes';
import { insertBeforeLatestDelegationBriefing } from './delegationBriefing';

export const RUN_USER_REQUEST_CONTEXT_SOURCE = 'run_user_request_context';

export function buildRunUserRequestContextMessage(userRequest: UserRequest): AIMessage {
  const message = new AIMessage(buildRunUserRequestContext(userRequest));
  setPinpetMeta(message, {
    source: RUN_USER_REQUEST_CONTEXT_SOURCE,
    synthetic: true,
  });
  return message;
}

/**
 * Project the stable run request into one Capability invocation without writing it
 * back to root or lane history. Keep the latest delegation briefing last so it
 * remains the immediate execution boundary for both initial and resumed work.
 */
export function withRunUserRequestContext(
  messages: BaseMessage[],
  userRequest: UserRequest,
): BaseMessage[] {
  const baseMessages = messages.filter((message) =>
    getPinpetMeta(message).source !== RUN_USER_REQUEST_CONTEXT_SOURCE);
  const contextMessage = buildRunUserRequestContextMessage(userRequest);
  return insertBeforeLatestDelegationBriefing(baseMessages, contextMessage);
}
