import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { ToolInputParsingException } from '@langchain/core/tools';
import { createMiddleware, ToolInvocationError } from 'langchain';
import { currentSupervisorTask, supervisorAgentStateSchema } from './state';
import { SupervisorDecisionError } from './controlContext';
import { isSupervisorControlTool } from './protocol';
import { readCapabilityExecutionCall } from '../executionMessages';

export function createSupervisorControlValidationMiddleware() {
  return createMiddleware({
    name: 'SupervisorControlValidation',
    stateSchema: supervisorAgentStateSchema,
    wrapToolCall: async (request, handler) => {
      // Preserve the SDK's unparsed JSON as failed input, never execute it.
      if (typeof request.toolCall.args === 'string') {
        return new ToolMessage({ name: request.toolCall.name, tool_call_id: request.toolCall.id!, status: 'error',
          content: `Tool arguments could not be parsed as a JSON object. Correct the arguments and retry. Received: ${request.toolCall.args}` });
      }
      try {
        return await handler(request);
      } catch (error) {
        // ToolNode validates arguments before invoking the tool body. Keep its
        // feedback, but mark failures explicitly so they cannot commit controls.
        const cause = error instanceof ToolInvocationError ? error.toolError : error;
        if (!(cause instanceof ToolInputParsingException) && !(cause instanceof SupervisorDecisionError)) throw error;
        const plan = cause instanceof SupervisorDecisionError ? request.state.runSupervisorState : null;
        return new ToolMessage({
          name: request.toolCall.name, tool_call_id: request.toolCall.id!, status: 'error',
          content: plan ? JSON.stringify({ error: cause.message, currentTask: currentSupervisorTask(plan), plan }) : cause.message,
        });
      }
    },
    beforeModel: {
      canJumpTo: ['end'],
      hook: (state) => {
        const last = state.messages.at(-1);
        // Only the request stamped by the handoff tool ends this loop. Errors return to the model.
        if (last && readCapabilityExecutionCall(last)) {
          return { jumpTo: 'end' as const };
        }
      },
    },
    wrapModelCall: async (request, handler) => {
      let response = await handler(request);
      if (!AIMessage.isInstance(response)) throw new Error('Supervisor must produce an AIMessage.');
      if (response.invalid_tool_calls?.length) {
        const invalidCalls = response.invalid_tool_calls.map(call => {
          if (!call.name || !call.id) throw new Error('Invalid Supervisor tool call requires a name and call id.');
          return { name: call.name, id: call.id, type: 'tool_call' as const,
            // ToolCall types assume parsed arguments. Keep raw input only until
            // wrapToolCall returns its error; do not fabricate usable arguments.
            args: (call.args ?? '') as unknown as Record<string, unknown> };
        });
        response = new AIMessage({ ...response,
          tool_calls: [...(response.tool_calls ?? []), ...invalidCalls], invalid_tool_calls: [] });
      }
      const calls = response.tool_calls ?? [];
      // ToolNode returns unknown-tool errors with the available names. Do not
      // intercept those here: the model needs the normal tool feedback to retry.
      if (calls.some((call) => !call.id)) throw new Error('Supervisor tool call requires a tool call id.');
      const controls = calls.filter((call) => isSupervisorControlTool(call.name));
      if (controls.length) {
        if (calls.length !== 1) throw new Error('Supervisor control must be the only tool call.');
      }
      return response;
    },
  });
}

