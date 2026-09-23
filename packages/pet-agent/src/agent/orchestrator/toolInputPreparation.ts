import { AIMessage, ToolMessage, type ToolCall } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { ToolDefinition, ToolInputPreparationContext } from '../../types/toolkit';
import { cloneAIMessageWithToolCalls, materializeToolCallIds, replaceMessageInState } from './toolCallMessages';

/** Prepare the actual arguments once before review, including full-access calls. */
export function createToolInputPreparationMiddleware(
  definitions: readonly ToolDefinition[],
  context: ToolInputPreparationContext,
) {
  const tools = new Map(definitions.filter((definition) => definition.prepareInput)
    .map(definition => [definition.tool.name, definition]));
  if (!tools.size) return null;
  return createMiddleware({
    name: 'ToolInputPreparation',
    afterModel: {
      hook: async (state) => {
        const messages = state.messages;
        let index = messages.length - 1;
        while (index >= 0 && !AIMessage.isInstance(messages[index])) index -= 1;
        if (index < 0) return;
        const message = messages[index] as AIMessage;
        if (!message.tool_calls?.length) return;
        let changed = false;
        const calls: ToolCall[] = [];
        const failures = new Map<number, string>();
        for (const [callIndex, call] of message.tool_calls.entries()) {
          const definition = tools.get(call.name);
          if (!definition) { calls.push(call); continue; }
          try {
            const args = await definition.prepareInput!(call.args, context);
            if (!args || typeof args !== 'object' || Array.isArray(args)) {
              throw new Error(`Tool "${call.name}" input preparation must return an argument object.`);
            }
            calls.push({ ...call, args: args as Record<string, unknown> });
            changed = true;
          } catch (error) {
            calls.push(call);
            failures.set(callIndex, error instanceof Error ? error.message : 'Input preparation failed.');
          }
        }
        if (failures.size) {
          // No call in this batch may reach review or execution: a partial batch
          // could produce side effects before the model sees the failed input.
          const materialized = materializeToolCallIds(calls, index);
          return { messages: replaceMessageInState(messages, index,
            cloneAIMessageWithToolCalls(message, materialized),
            materialized.map((call, callIndex) => new ToolMessage({
              name: call.name, tool_call_id: call.id!, status: 'error',
              content: failures.get(callIndex)
                ?? 'This call was not executed because another call in the batch had invalid input. Retry it.',
            })),
          ), jumpTo: 'model' as const };
        }
        if (changed) return { messages: replaceMessageInState(
          messages, index, cloneAIMessageWithToolCalls(message, calls), [],
        ) };
      },
      canJumpTo: ['model'],
    },
  });
}
