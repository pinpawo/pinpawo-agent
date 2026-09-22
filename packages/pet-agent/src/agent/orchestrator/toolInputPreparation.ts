import { AIMessage, type ToolCall } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { AgentToolkit, ToolDefinition } from '../../types/toolkit';
import { cloneAIMessageWithToolCalls, replaceMessageInState } from './toolCallMessages';

/** Prepare the actual arguments once before review, including full-access calls. */
export function createToolInputPreparationMiddleware(
  bindings: readonly { toolkit: AgentToolkit; definition: ToolDefinition }[],
  context: Readonly<Record<string, unknown>>,
) {
  const tools = new Map(bindings.filter(({ definition }) => definition.prepareInput)
    .map(binding => [binding.definition.tool.name, binding]));
  if (!tools.size) return null;
  return createMiddleware({
    name: 'ToolInputPreparation',
    afterModel: async (state) => {
      const messages = state.messages;
      let index = messages.length - 1;
      while (index >= 0 && !AIMessage.isInstance(messages[index])) index -= 1;
      if (index < 0) return;
      const message = messages[index] as AIMessage;
      if (!message.tool_calls?.length) return;
      let changed = false;
      const calls: ToolCall[] = [];
      for (const call of message.tool_calls) {
        const binding = tools.get(call.name);
        if (!binding) { calls.push(call); continue; }
        const args = await binding.definition.prepareInput!(call.args, {
          toolkitName: binding.toolkit.name, toolName: call.name, context,
        });
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error(`Tool "${call.name}" input preparation must return an argument object.`);
        }
        calls.push({ ...call, args: args as Record<string, unknown> });
        changed = true;
      }
      if (changed) return { messages: replaceMessageInState(
        messages, index, cloneAIMessageWithToolCalls(message, calls), [],
      ) };
    },
  });
}
