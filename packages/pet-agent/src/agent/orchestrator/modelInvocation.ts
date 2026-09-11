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

/** Filter incomplete tool pairs only in model input, never in canonical state. */
export const toolProtocolMiddleware = createMiddleware({
  name: 'ToolProtocol',
  wrapModelCall: (request, handler) => handler({
    ...request,
    messages: toolProtocolSafeMessages(request.messages),
  }),
});

/** Root's direct Entry model also reads legacy checkpoint evidence. */
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
    ...toolProtocolSafeMessages(projectDelegationAnnouncesForModel(input.messages)),
  ], runnableConfig);
}
