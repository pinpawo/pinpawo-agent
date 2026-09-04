import {
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { Command, END } from '@langchain/langgraph';
import { createMiddleware, ToolInvocationError } from 'langchain';
import { ToolInputParsingException } from '@langchain/core/tools';
import { buildRunSupervisorAgentSystemPrompt } from '../prompts/runSupervisorAgent';
import { parseSupervisorCommand, type SupervisorCommand } from './protocol';
import {
  currentSupervisorInput,
  supervisorCommandContext,
  supervisorInvocationStateSchema,
} from './supervisorState';
import {
  SUPERVISOR_COMMAND_TOOL_NAMES,
  supervisorCommandToolNamesForMode,
} from './commandTools';

function readCommandResult(message: ToolMessage): unknown {
  if (message.status === 'error' || typeof message.content !== 'string') {
    return null;
  }
  try {
    return JSON.parse(message.content);
  } catch {
    return null;
  }
}

function supervisorSystemMessage(
  input: ReturnType<typeof currentSupervisorInput>,
) {
  return new SystemMessage(buildRunSupervisorAgentSystemPrompt(input.mode));
}

/** Framework lifecycle control only: model protocol and control commands. */
export function createSupervisorMiddleware() {
  return createMiddleware({
    name: 'RunSupervisor',
    stateSchema: supervisorInvocationStateSchema,
    wrapModelCall: async (request, handler) => {
      const input = currentSupervisorInput(request.state);
      if (request.state.supervisorCommand) {
        return new Command({
          update: { jumpTo: 'end' },
          goto: END,
        });
      }
      const systemMessage = supervisorSystemMessage(input);
      const allowedCommandToolNames = supervisorCommandToolNamesForMode(input.mode);
      return handler({
        ...request,
        systemMessage,
        tools: request.tools.filter(({ name }) =>
          typeof name !== 'string'
          || !SUPERVISOR_COMMAND_TOOL_NAMES.has(name)
          || allowedCommandToolNames.has(name)),
      });
    },
    wrapToolCall: async (request, handler) => {
      let result: Awaited<ReturnType<typeof handler>>;
      try {
        result = await handler(request);
      } catch (error) {
        const parsingError = error instanceof ToolInputParsingException
          ? error
          : error instanceof ToolInvocationError
            && error.toolError instanceof ToolInputParsingException
            ? error.toolError
            : null;
        if (!parsingError || !request.toolCall.id) {
          throw error;
        }
        return new ToolMessage({
          content: parsingError.message,
          name: request.toolCall.name,
          status: 'error',
          tool_call_id: request.toolCall.id,
        });
      }
      if (!ToolMessage.isInstance(result)
        || !SUPERVISOR_COMMAND_TOOL_NAMES.has(request.toolCall.name)) {
        return result;
      }
      const rawCommand = readCommandResult(result);
      if (!rawCommand) return result;
      const input = currentSupervisorInput(request.state);
      let command: SupervisorCommand;
      try {
        command = parseSupervisorCommand(rawCommand, supervisorCommandContext(input));
      } catch (error) {
        return new ToolMessage({
          content: error instanceof Error ? error.message : String(error),
          name: result.name,
          status: 'error',
          tool_call_id: result.tool_call_id,
        });
      }
      return new Command({
        update: {
          messages: [result],
          supervisorCommand: command,
          jumpTo: 'end',
        },
        goto: END,
      });
    },
  });
}
