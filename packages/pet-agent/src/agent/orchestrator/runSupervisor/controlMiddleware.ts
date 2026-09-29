import { AIMessage, HumanMessage, RemoveMessage, ToolMessage } from '@langchain/core/messages';
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
          runCapabilityDisclosure: mergeCapabilityDisclosure(input.capabilityDisclosure,
            request.state.disclosedCapabilityNames ?? []),
          ...(input.inputId.startsWith('human:') ? { runSupervisorUserMessageId: input.inputId } : {}),
          messages: supervisorWorkMessages(supervisorHandoffContext(input), request.state.messages.slice(messageCount), true),
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

export const SUPERVISOR_EMPTY_REPLY_REPAIR_ID = 'supervisor-empty-reply-repair';

const EMPTY_REPLY_REPAIR = [
  '你上一轮的输出为空：既没有回复，也没有调用工具，因此不会有任何事情发生。',
  '现在重新处理这一轮：需要执行就调用相应的工具；需要用户补充信息或确认就直接提问；否则给出面向用户的最终回复。',
].join('\n');

/**
 * One real retry for an empty turn, never a fabricated answer. The empty turn is
 * removed (providers reject empty assistant content) and the nudge is not a work
 * record, so neither reaches the Supervisor lane. A second empty turn stays a
 * protocol error.
 */
export const supervisorEmptyReplyRepairMiddleware = createMiddleware({
  name: 'SupervisorEmptyReplyRepair',
  afterModel: {
    hook: (state) => {
      const last = state.messages.at(-1);
      // A malformed tool call is not an empty turn; it keeps its own protocol path.
      if (!AIMessage.isInstance(last) || last.tool_calls?.length || last.invalid_tool_calls?.length
        || last.text.trim() || !last.id) return undefined;
      if (state.messages.some((message) => message.id === SUPERVISOR_EMPTY_REPLY_REPAIR_ID)) return undefined;
      return {
        messages: [
          new RemoveMessage({ id: last.id }),
          new HumanMessage({ id: SUPERVISOR_EMPTY_REPLY_REPAIR_ID, content: EMPTY_REPLY_REPAIR }),
        ],
        jumpTo: 'model' as const,
      };
    },
    canJumpTo: ['model'],
  },
});
