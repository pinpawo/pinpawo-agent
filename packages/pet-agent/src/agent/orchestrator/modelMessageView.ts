import type { BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { toolProtocolSafeMessages } from '../messages';
import { projectDelegationAnnouncesForModel } from './delegation';

/** Return the ephemeral model-visible view of Agent messages. */
export function modelVisibleMessages(
  messages: readonly BaseMessage[],
): BaseMessage[] {
  return toolProtocolSafeMessages(
    projectDelegationAnnouncesForModel(messages),
  );
}

/** LangChain adapter that applies the model-visible view at every model call. */
export const modelMessageViewMiddleware = createMiddleware({
  name: 'OrchestratorModelMessageView',
  wrapModelCall: (request, handler) => handler({
    ...request,
    messages: modelVisibleMessages(request.messages),
  }),
});
