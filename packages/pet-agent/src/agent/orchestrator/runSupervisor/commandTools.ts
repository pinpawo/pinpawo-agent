import { ToolMessage } from '@langchain/core/messages';
import { tool, type StructuredTool, type ToolRuntime } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { acceptResultSchema, continueCurrentSchema, submitPlanSchema, parseSupervisorCommand } from './protocol';
import { currentSupervisorInput, supervisorCommandContext, type SupervisorInvocationState } from './supervisorState';

export const CONTINUE_CURRENT_TOOL_NAME = 'continue_current';
export const SUBMIT_PLAN_TOOL_NAME = 'submit_plan';
export const ACCEPT_RESULT_TOOL_NAME = 'accept_result';
export type SupervisorCommandToolMode = 'entry' | 'boundary';
export const SUPERVISOR_COMMAND_TOOL_NAMES = new Set([
  CONTINUE_CURRENT_TOOL_NAME, SUBMIT_PLAN_TOOL_NAME, ACCEPT_RESULT_TOOL_NAME,
]);
export function supervisorCommandToolNamesForMode(mode: SupervisorCommandToolMode): ReadonlySet<string> {
  return mode === 'entry' ? new Set([SUBMIT_PLAN_TOOL_NAME])
    : new Set([CONTINUE_CURRENT_TOOL_NAME, ACCEPT_RESULT_TOOL_NAME]);
}

/** End this invocation with a typed proposal; only the root applies its effects. */
function propose(name: string, value: unknown, runtime: ToolRuntime<SupervisorInvocationState>) {
  const supervisorCommand = parseSupervisorCommand(value,
    supervisorCommandContext(currentSupervisorInput(runtime.state)));
  return new Command({ update: {
    supervisorCommand,
    messages: [new ToolMessage({ name, tool_call_id: runtime.toolCallId, content: 'Control proposal submitted.' })],
  } });
}

export function createSupervisorCommandTools(mode?: SupervisorCommandToolMode): StructuredTool[] {
  const tools = [
    tool((args, runtime: ToolRuntime<SupervisorInvocationState>) => propose(SUBMIT_PLAN_TOOL_NAME,
      { action: 'execute_plan', ...args }, runtime), {
      name: SUBMIT_PLAN_TOOL_NAME, schema: submitPlanSchema, returnDirect: true,
      description: 'Entry only: submit the ordered execution plan. The root dispatches its first task.',
    }),
    tool((args, runtime: ToolRuntime<SupervisorInvocationState>) => propose(CONTINUE_CURRENT_TOOL_NAME,
      { action: 'continue_current', ...args }, runtime), {
      name: CONTINUE_CURRENT_TOOL_NAME, schema: continueCurrentSchema, returnDirect: true,
      description: 'Boundary only: continue the same delegation with optional feedback. Omit remainingPlan to retain future tasks; change it only following user confirmation.',
    }),
    tool((args, runtime: ToolRuntime<SupervisorInvocationState>) => propose(ACCEPT_RESULT_TOOL_NAME,
      { action: 'accept_result', ...args }, runtime), {
      name: ACCEPT_RESULT_TOOL_NAME, schema: acceptResultSchema, returnDirect: true,
      description: 'Boundary only: accept the evidenced current task. Without reply, dispatch the next planned task. With reply, end this run and save future tasks. An empty future plan requires a final reply. Omit remainingPlan to retain it; changes require user confirmation.',
    }),
  ];
  return mode ? tools.filter(({ name }) => supervisorCommandToolNamesForMode(mode).has(name)) : tools;
}
