import { randomUUID } from 'node:crypto';
import { AIMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { isToolCallContentBlock, readMessageToolCallIds } from '../../utils/messages';
import { toolProtocolSafeMessages } from '../messages';
import { getAgentRuntimeContext } from '../../runtime/context';
import { composeSystemPrompt } from '../../prompts/systemPrompt';

type InvokableMessageModel<TOutput extends BaseMessage> = {
  invoke(
    messages: BaseMessage[],
    runnableConfig?: RunnableConfig,
  ): Promise<TOutput>;
};

/**
 * Give every tool call in a model response an ID that is unique in its history.
 *
 * Tool results pair with calls by ID across a history that spans runs, so the
 * ID is settled once, where the call is born. Provider IDs are kept as they
 * are; only a missing ID, or one the history or this response already uses
 * (some providers number calls per turn), gets a fresh one. A streamed message
 * repeats each call in its content blocks and raw `additional_kwargs`, so a
 * replaced ID is replaced in all of them and the message stays one shape.
 */
export function assignToolCallIds<T extends BaseMessage>(response: T, history: readonly BaseMessage[]): T {
  if (!AIMessage.isInstance(response) || !response.tool_calls?.length) return response;
  const used = new Set(history.flatMap((message) => readMessageToolCallIds(message)));
  const toolCalls = response.tool_calls.map((call) => {
    if (call.id && !used.has(call.id)) {
      used.add(call.id);
      return call;
    }
    const id = `call_${randomUUID()}`;
    used.add(id);
    return { ...call, id };
  });
  if (toolCalls.every((call, index) => call === response.tool_calls![index])) return response;
  // The block and raw copies list the same calls in the same order.
  const renamed = (blocks: unknown[], isCall: (block: unknown) => boolean) => {
    if (blocks.filter(isCall).length !== toolCalls.length) return blocks;
    let index = 0;
    return blocks.map((block) => isCall(block) ? { ...(block as object), id: toolCalls[index++]!.id } : block);
  };
  const content = Array.isArray(response.content)
    ? renamed(response.content, isToolCallContentBlock) as typeof response.content
    : response.content;
  const rawCalls = response.additional_kwargs?.tool_calls;
  return new AIMessage({
    ...response,
    content,
    additional_kwargs: Array.isArray(rawCalls)
      ? { ...response.additional_kwargs, tool_calls: renamed(rawCalls, () => true) as typeof rawCalls }
      : response.additional_kwargs,
    tool_calls: toolCalls,
  }) as unknown as T;
}

/**
 * Filter incomplete tool pairs only in model input, never in canonical state,
 * and settle the response's tool call IDs.
 *
 * `uniqueInHistory` checks IDs against the agent's whole history; it is for
 * agents whose calls land in the main history that spans runs. A Capability
 * subagent replays its turn on review resume, where its own earlier call is
 * already in the history and must keep its ID, so it only fills missing and
 * repeated-in-response IDs.
 */
export function createToolProtocolMiddleware({ uniqueInHistory = false } = {}) {
  return createMiddleware({
    name: 'ToolProtocol',
    wrapModelCall: async (request, handler) => {
      const response = await handler({
        ...request,
        messages: toolProtocolSafeMessages(request.messages),
      });
      return AIMessage.isInstance(response)
        ? assignToolCallIds(response, uniqueInHistory ? request.state.messages ?? [] : [])
        : response;
    },
  });
}

export const toolProtocolMiddleware = createToolProtocolMiddleware();

/** Apply the same model-input tool pairing as createAgent. */
export async function invokeOrchestratorModel<TOutput extends BaseMessage>(
  model: InvokableMessageModel<TOutput>,
  input: {
    systemMessage: SystemMessage;
    messages: readonly BaseMessage[];
    /** Every message the response's tool call IDs must not collide with; defaults to `messages`. */
    history?: readonly BaseMessage[];
  },
  runnableConfig?: LangGraphRunnableConfig,
) {
  const response = await model.invoke([
    composeSystemPrompt(input.systemMessage, getAgentRuntimeContext(runnableConfig)),
    ...toolProtocolSafeMessages(input.messages),
  ], runnableConfig);
  return assignToolCallIds(response, input.history ?? input.messages);
}
