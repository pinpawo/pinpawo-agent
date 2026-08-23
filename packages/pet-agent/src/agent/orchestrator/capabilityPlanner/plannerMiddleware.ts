import {
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { Command, END } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { buildCapabilityPlannerAgentSystemPrompt } from '../prompts/capabilityPlannerAgent';
import { parsePlannerCommit, type PlannerCommit } from './protocol';
import {
  currentPlannerInput,
  plannerCommitContext,
  plannerInvocationStateSchema,
} from './plannerState';
import { PLANNER_TERMINAL_TOOL_NAMES } from './terminalTools';

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

function plannerSystemMessage(input: ReturnType<typeof currentPlannerInput>, defaultCapability: Parameters<typeof buildCapabilityPlannerAgentSystemPrompt>[1]) {
  return new SystemMessage(buildCapabilityPlannerAgentSystemPrompt(
    input.mode,
    defaultCapability,
  ));
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
      const systemMessage = plannerSystemMessage(
        input,
        request.state.defaultCapability ?? null,
      );
      return handler({ ...request, systemMessage });
    },
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
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
