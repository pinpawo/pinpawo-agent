import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { ToolInputParsingException } from '@langchain/core/tools';
import { createMiddleware, ToolInvocationError } from 'langchain';
import { currentSupervisorTask, supervisorAgentStateSchema } from './state';
import { SupervisorDecisionError } from './controlContext';
import { isSupervisorControlTool } from './protocol';
import { Command } from '@langchain/langgraph';
import type { RunSupervisorInput } from './runner';
import { supervisorHandoffContext } from './input';
import { supervisorWorkMessages } from './messageHandoff';
import { mergeCapabilityDisclosure } from './capabilityDisclosure';

export function createSupervisorControlValidationMiddleware(input: RunSupervisorInput, messageCount: number) {
  return createMiddleware({
    name: 'SupervisorControlValidation',
    stateSchema: supervisorAgentStateSchema,
    wrapToolCall: async (request, handler) => {
      // Plan changes and handoff depend on the preceding tool result.
      const message = request.state.messages.at(-1);
      const calls = AIMessage.isInstance(message) ? message.tool_calls ?? [] : [];
      if (calls.length > 1 && calls.some(call => isSupervisorControlTool(call.name))) {
        return new ToolMessage({ name: request.toolCall.name, tool_call_id: request.toolCall.id!, status: 'error',
          content: 'Plan changes and delegation must be called individually. Retry one tool at a time; none of this batch was executed.' });
      }
      if (request.toolCall.name === 'delegate_capability') {
        return new Command({ graph: Command.PARENT, goto: 'capability', update: {
          runSupervisorState: request.state.runSupervisorState,
          runSupervisorReviewFeedback: request.state.reviewFeedback,
          runCapabilityDisclosure: mergeCapabilityDisclosure(input.capabilityDisclosure,
            request.state.disclosedCapabilityNames ?? []),
          ...(input.inputId.startsWith('human:') ? { runSupervisorUserMessageId: input.inputId } : {}),
          messages: supervisorWorkMessages(supervisorHandoffContext(input), request.state.messages.slice(messageCount)),
        } });
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
  });
}
