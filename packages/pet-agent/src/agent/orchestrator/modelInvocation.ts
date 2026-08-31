import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { createMiddleware } from 'langchain';
import { toolProtocolSafeMessages } from '../messages';
import { projectDelegationAnnouncesForModel } from './delegation';

type InvokableMessageModel<TOutput extends BaseMessage> = {
  invoke(
    messages: BaseMessage[],
    runnableConfig?: RunnableConfig,
  ): Promise<TOutput>;
};

function providerMessages(messages: readonly BaseMessage[]): BaseMessage[] {
  return toolProtocolSafeMessages(
    projectDelegationAnnouncesForModel(messages),
  );
}

/** Internal LangChain wiring for Agent model calls. */
export const orchestratorModelInvocationMiddleware = createMiddleware({
  name: 'OrchestratorModelInvocation',
  wrapModelCall: (request, handler) => handler({
    ...request,
    messages: providerMessages(request.messages),
  }),
});

/** Invoke a direct model with independently owned system and Agent messages. */
export function invokeOrchestratorModel<TOutput extends BaseMessage>(
  model: InvokableMessageModel<TOutput>,
  input: {
    systemMessage: SystemMessage;
    messages: readonly BaseMessage[];
  },
  runnableConfig?: RunnableConfig,
) {
  return model.invoke([
    input.systemMessage,
    ...providerMessages(input.messages),
  ], runnableConfig);
}
