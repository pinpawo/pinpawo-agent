import { tool, type StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

const MAX_PLAN_TASKS = 24;
const MAX_TASK_TEXT_CHARS = 2_000;

export const CONTINUE_CURRENT_TOOL_NAME = 'continue_current';
export const SUBMIT_PLAN_TOOL_NAME = 'submit_plan';
export const ADVANCE_PLAN_TOOL_NAME = 'advance_plan';
export const COMPLETE_GOAL_TOOL_NAME = 'complete_goal';
export const REQUEST_USER_INPUT_TOOL_NAME = 'request_user_input';
export const REPORT_UNAVAILABLE_TOOL_NAME = 'report_unavailable';

export type PlannerTerminalToolMode = 'entry' | 'boundary';

export const PLANNER_TERMINAL_TOOL_NAMES = new Set([
  CONTINUE_CURRENT_TOOL_NAME,
  SUBMIT_PLAN_TOOL_NAME,
  ADVANCE_PLAN_TOOL_NAME,
  COMPLETE_GOAL_TOOL_NAME,
  REQUEST_USER_INPUT_TOOL_NAME,
  REPORT_UNAVAILABLE_TOOL_NAME,
]);

const ENTRY_TERMINAL_TOOL_NAMES = new Set([
  SUBMIT_PLAN_TOOL_NAME,
  REQUEST_USER_INPUT_TOOL_NAME,
  REPORT_UNAVAILABLE_TOOL_NAME,
]);

const BOUNDARY_TERMINAL_TOOL_NAMES = new Set([
  CONTINUE_CURRENT_TOOL_NAME,
  ADVANCE_PLAN_TOOL_NAME,
  COMPLETE_GOAL_TOOL_NAME,
  REQUEST_USER_INPUT_TOOL_NAME,
  REPORT_UNAVAILABLE_TOOL_NAME,
]);

export function plannerTerminalToolNamesForMode(
  mode: PlannerTerminalToolMode,
): ReadonlySet<string> {
  return mode === 'entry'
    ? ENTRY_TERMINAL_TOOL_NAMES
    : BOUNDARY_TERMINAL_TOOL_NAMES;
}

function plannerTaskSchema() {
  return z.object({
    capability: z.string().trim().min(1).max(200)
      .describe('Name of a disclosed Capability whose responsibility matches this task.'),
    task: z.string().trim().min(1).max(MAX_TASK_TEXT_CHARS)
      .describe('One independently deliverable result for that Capability, not an internal phase.'),
  });
}

function plannerTasksSchema(description: string) {
  return z.array(plannerTaskSchema()).min(1).max(MAX_PLAN_TASKS)
    .describe(description);
}

/** Terminal tools serialize an already-made Planner decision. */
export function createPlannerTerminalTools(
  mode?: PlannerTerminalToolMode,
): StructuredTool[] {
  const tools = [
    tool(async () => JSON.stringify({ action: 'continue_current', tasks: [] }), {
      name: CONTINUE_CURRENT_TOOL_NAME,
      description: 'Boundary only: keep the active delegation and prior plan unchanged for another autonomous attempt.',
      schema: z.object({}).strict(),
    }),
    tool(
      async ({ tasks }: { tasks: Array<{ capability: string; task: string }> }) =>
        JSON.stringify({ action: 'execute_plan', tasks }),
      {
        name: SUBMIT_PLAN_TOOL_NAME,
        description: 'Entry only: commit the initial executable plan for the user goal.',
        schema: z.object({
          tasks: plannerTasksSchema(
            'Non-empty ordered tasks required to deliver the user goal.',
          ),
        }),
      },
    ),
    tool(
      async ({ tasks }: { tasks: Array<{ capability: string; task: string }> }) =>
        JSON.stringify({ action: 'advance_plan', tasks }),
      {
        name: ADVANCE_PLAN_TOOL_NAME,
        description: 'Boundary only: accept the active result and replace the prior proposal with the tasks still required for the user goal.',
        schema: z.object({
          tasks: plannerTasksSchema(
            'Non-empty ordered tasks for results not yet satisfied by accepted history and the active result.',
          ),
        }),
      },
    ),
    tool(async () => JSON.stringify({ action: 'goal_done', tasks: [] }), {
      name: COMPLETE_GOAL_TOOL_NAME,
      description: 'Boundary only: accept the active result and close the user goal when no requested result or user-owned input remains outstanding.',
      schema: z.object({}).strict(),
    }),
    tool(
      async ({ question }: { question: string }) => JSON.stringify({
        action: 'user_input_required',
        tasks: [],
        userInputRequest: { question },
      }),
      {
        name: REQUEST_USER_INPUT_TOOL_NAME,
        description: 'Pause the unfinished goal in a resumable state and ask for concrete information, a choice, or authorization only the user can provide.',
        schema: z.object({
          question: z.string().trim().min(1).max(1_000)
            .describe('The single concrete question that unblocks planning.'),
        }).strict(),
      },
    ),
    tool(async () => JSON.stringify({ action: 'unavailable', tasks: [] }), {
      name: REPORT_UNAVAILABLE_TOOL_NAME,
      description: 'Return control because no disclosed or discoverable Capability can execute the remaining goal.',
      schema: z.object({}).strict(),
    }),
  ];
  if (!mode) return tools;
  const allowedNames = plannerTerminalToolNamesForMode(mode);
  return tools.filter(({ name }) => allowedNames.has(name));
}
