import type { BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { toolProtocolSafeMessages } from '../messages';
import { projectDelegationAnnouncesForModel } from './delegation';

/**
 * Prepare the complete message list immediately before a model invocation.
 * Canonical agent state remains untouched; only the provider-facing request is
 * projected and repaired.
 */
export function prepareModelRequestMessages(
  messages: readonly BaseMessage[],
): BaseMessage[] {
  return toolProtocolSafeMessages(
    projectDelegationAnnouncesForModel(messages),
  );
}

/** Apply provider-facing message preparation to every model call in an agent. */
export function createModelRequestMessagesMiddleware() {
  return createMiddleware({
    name: 'OrchestratorModelRequestMessages',
    wrapModelCall: (request, handler) => handler({
      ...request,
      messages: prepareModelRequestMessages(request.messages),
    }),
  });
}
