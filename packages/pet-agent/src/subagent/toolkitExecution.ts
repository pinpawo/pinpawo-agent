import { ToolMessage } from '@langchain/core/messages';
import { ToolInputParsingException } from '@langchain/core/tools';
import { getConfig, isCommand, isGraphInterrupt } from '@langchain/langgraph';
import { createMiddleware, ToolInvocationError } from 'langchain';
import type { SubagentRunInput } from '../types/subagent';
import { isAbortError } from '../types/toolCancellation';

/** Last tool middleware: all caller-provided wrappers still surround execution. */
export function createToolkitExecutionMiddleware(input: SubagentRunInput) {
  const owners = input.toolkitNamesByTool;
  if (!owners) return null;
  const staticTools = new Map(input.tools.map(tool => [tool.name, tool]));
  return createMiddleware({
    name: 'ToolkitExecution',
    wrapToolCall: async (request, handler) => {
      const toolkitName = Object.hasOwn(owners, request.toolCall.name) ? owners[request.toolCall.name] : undefined;
      if (!toolkitName) return handler(request);
      const tool = staticTools.get(request.toolCall.name);
      // A known Tool may be filtered out for this model's input modalities.
      // ToolNode returns recoverable invalid-tool feedback for that request.
      if (!tool) return handler(request);
      // LangChain ToolNode closes over config and ignores request.runtime
      // overrides. Invoke the unchanged registered Tool with explicit context.
      const config = getConfig();
      const context = request.runtime.context;
      try {
        request.runtime.signal?.throwIfAborted();
        const output = await tool.invoke({ ...request.toolCall, type: 'tool_call' }, {
          ...config,
          ...request.runtime,
          config,
          state: config.configurable?.__pregel_scratchpad?.currentTaskInput ?? request.state,
          toolCallId: request.toolCall.id,
          context: { ...(context && typeof context === 'object' ? context : {}), toolkitName },
        });
        request.runtime.signal?.throwIfAborted();
        if (ToolMessage.isInstance(output) || isCommand(output)) return output;
        return new ToolMessage({ name: request.toolCall.name, tool_call_id: request.toolCall.id!,
          content: typeof output === 'string' ? output : JSON.stringify(output) });
      } catch (error) {
        if (isGraphInterrupt(error) || isAbortError(error) || request.runtime.signal?.aborted) throw error;
        // ToolNode converts ordinary tool failures into model feedback. Its
        // middleware path does not, so preserve that behavior at this boundary.
        const failure = error instanceof ToolInputParsingException
          ? new ToolInvocationError(error, request.toolCall) : error;
        return new ToolMessage({ name: request.toolCall.name, tool_call_id: request.toolCall.id!, status: 'error',
          content: failure instanceof Error ? failure.message : String(failure) });
      }
    },
  });
}
