import {
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { Command, END } from '@langchain/langgraph';
import { createMiddleware, ToolInvocationError } from 'langchain';
import { ToolInputParsingException } from '@langchain/core/tools';
import { buildCapabilityPlannerAgentSystemPrompt } from '../prompts/capabilityPlannerAgent';
import { parsePlannerCommit, type PlannerCommit } from './protocol';
import {
  currentPlannerInput,
  plannerCommitContext,
  plannerInvocationStateSchema,
} from './plannerState';
import {
  PLANNER_TERMINAL_TOOL_NAMES,
  plannerTerminalToolNamesForMode,
} from './terminalTools';

function readTerminalCommit(message: ToolMessage): unknown {
  if (message.status === 'error' || typeof message.content !== 'string') {
    return null;
  }
  try {
    return JSON.parse(message.content);
  } catch {
    return null;
  }
}

function plannerSystemMessage(input: ReturnType<typeof currentPlannerInput>) {
  return new SystemMessage(buildCapabilityPlannerAgentSystemPrompt(input.mode));
}

/** Framework lifecycle control only: model protocol and terminal commit. */
export function createPlannerMiddleware() {
  return createMiddleware({
    name: 'CapabilityPlanner',
    stateSchema: plannerInvocationStateSchema,
    wrapModelCall: async (request, handler) => {
      const input = currentPlannerInput(request.state);
      if (request.state.plannerCommit) {
        return new Command({
          update: { jumpTo: 'end' },
          goto: END,
        });
      }
      const systemMessage = plannerSystemMessage(input);
      const allowedTerminalToolNames = plannerTerminalToolNamesForMode(input.mode);
      return handler({
        ...request,
        systemMessage,
        tools: request.tools.filter(({ name }) =>
          typeof name !== 'string'
          || !PLANNER_TERMINAL_TOOL_NAMES.has(name)
          || allowedTerminalToolNames.has(name)),
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
        || !PLANNER_TERMINAL_TOOL_NAMES.has(request.toolCall.name)) {
        return result;
      }
      const rawCommit = readTerminalCommit(result);
      if (!rawCommit) return result;
      const input = currentPlannerInput(request.state);
      let commit: PlannerCommit;
      try {
        commit = parsePlannerCommit(rawCommit, plannerCommitContext(input));
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
          plannerCommit: commit,
          jumpTo: 'end',
        },
        goto: END,
      });
    },
  });
}
