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

export const PLANNER_TERMINAL_TOOL_NAMES = new Set([
  CONTINUE_CURRENT_TOOL_NAME,
  SUBMIT_PLAN_TOOL_NAME,
  ADVANCE_PLAN_TOOL_NAME,
  COMPLETE_GOAL_TOOL_NAME,
  REQUEST_USER_INPUT_TOOL_NAME,
  REPORT_UNAVAILABLE_TOOL_NAME,
]);

function plannerTaskSchema() {
  return z.object({
    capability: z.string().trim().min(1).max(200)
      .describe('Registered Capability name for this task.'),
    task: z.string().trim().min(1).max(MAX_TASK_TEXT_CHARS)
      .describe('The task goal to deliver.'),
  });
}

function plannerTasksSchema() {
  return z.array(plannerTaskSchema()).min(1).max(MAX_PLAN_TASKS)
    .describe('The non-empty ordered task sequence committed by this action.');
}

/** Terminal tools serialize an already-made Planner decision. */
export function createPlannerTerminalTools(): StructuredTool[] {
  return [
    tool(async () => JSON.stringify({ action: 'continue_current', tasks: [] }), {
      name: CONTINUE_CURRENT_TOOL_NAME,
      description: [
        'Keep the active delegation and its existing remaining plan unchanged.',
        'Use when the latest announce does not establish that the current task is accepted,',
        'including an intended-work plan, an unexecuted attempt, or incomplete evidence.',
      ].join(' '),
      schema: z.object({}).strict(),
    }),
    tool(
      async ({ tasks }: { tasks: Array<{ capability: string; task: string }> }) =>
        JSON.stringify({ action: 'execute_plan', tasks }),
      {
        name: SUBMIT_PLAN_TOOL_NAME,
        description: 'Submit execute_plan with the initial ordered tasks.',
        schema: z.object({ tasks: plannerTasksSchema() }),
      },
    ),
    tool(
      async ({ tasks }: { tasks: Array<{ capability: string; task: string }> }) =>
        JSON.stringify({ action: 'advance_plan', tasks }),
      {
        name: ADVANCE_PLAN_TOOL_NAME,
        description: [
          'After the active task is accepted, submit the ordered remaining tasks.',
          'Start from the existing remaining-plan tasks exactly as written.',
          'Change, remove, or add a task only when the latest announce provides concrete',
          'evidence that requires that specific change; do not rewrite a task merely to add detail.',
        ].join(' '),
        schema: z.object({ tasks: plannerTasksSchema() }),
      },
    ),
    tool(async () => JSON.stringify({ action: 'goal_done', tasks: [] }), {
      name: COMPLETE_GOAL_TOOL_NAME,
      description: 'Submit goal_done with no tasks.',
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
        description: 'Submit user_input_required with the question Answer should ask.',
        schema: z.object({
          question: z.string().trim().min(1).max(1_000)
            .describe('The concrete question to present to the user.'),
        }).strict(),
      },
    ),
    tool(async () => JSON.stringify({ action: 'unavailable', tasks: [] }), {
      name: REPORT_UNAVAILABLE_TOOL_NAME,
      description: 'Submit unavailable with no tasks.',
      schema: z.object({}).strict(),
    }),
  ];
}
