import { AIMessage, ToolMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { toolProtocolSafeMessages } from '../messages';
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
  wrapModelCall: async (request, handler) => {
    const response = await handler({ ...request, messages: toolProtocolSafeMessages(request.messages) });
    if (!AIMessage.isInstance(response) || !response.invalid_tool_calls?.length) return response;
    // Route parse failures through the normal tool loop, retaining their raw input.
    // The tool wrapper below rejects them before any tool (including handoff) executes.
    const invalid = response.invalid_tool_calls.map(call => {
      if (!call.name || !call.id) throw new Error('Invalid tool call is missing its name or id.');
      return { name: call.name, id: call.id, type: 'tool_call' as const,
        args: (call.args ?? '') as unknown as Record<string, unknown> };
    });
    return new AIMessage({ ...response,
      tool_calls: [...(response.tool_calls ?? []), ...invalid], invalid_tool_calls: [] });
  },
  wrapToolCall: (request, handler) => {
    if (typeof request.toolCall.args === 'string') {
      return new ToolMessage({ name: request.toolCall.name, tool_call_id: request.toolCall.id!,
        status: 'error', content: 'Tool arguments could not be parsed as JSON. Retry this tool call with valid JSON; escape quotes inside strings. The tool was not executed.' });
    }
    return handler(request);
  },
});

/** Apply the same model-input tool pairing as createAgent. */
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
    ...toolProtocolSafeMessages(input.messages),
  ], runnableConfig);
}
