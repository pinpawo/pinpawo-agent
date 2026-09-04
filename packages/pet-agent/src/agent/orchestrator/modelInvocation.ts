import { SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { toolProtocolSafeMessages } from '../messages';
import { projectDelegationAnnouncesForModel } from './delegation';
import { getAgentRuntimeContext } from '../../runtime/context';
import { composeSystemPrompt } from '../../prompts/systemPrompt';

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

/** Delegation projection and tool protocol repair have no prompt ownership. */
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
  runnableConfig?: LangGraphRunnableConfig,
) {
  return model.invoke([
    composeSystemPrompt(input.systemMessage, getAgentRuntimeContext(runnableConfig)),
    ...providerMessages(input.messages),
  ], runnableConfig);
}
