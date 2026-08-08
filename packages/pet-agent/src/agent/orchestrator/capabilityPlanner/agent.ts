import {
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool, type StructuredTool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { createAgent, createMiddleware } from 'langchain';
import { z } from 'zod';
import {
  CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
  createCapabilityPlannerFileExplorer,
} from './fileExplorer';
import type { CapabilityRegistryBackend } from './registryDocuments';
import {
  buildCapabilityPlannerAgentInput,
  buildCapabilityPlannerAgentSystemPrompt,
} from '../prompts/capabilityPlannerAgent';
import { readMessageText } from '../utils';
import type {
  CapabilityPlannerInput,
  CapabilityPlannerResult,
  CapabilityPlannerRunner,
} from './runner';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PLAN_TASKS = 24;
const MAX_TASK_TEXT_CHARS = 500;
const MAX_REASON_CHARS = 1_000;
const MAX_ANSWER_CONTEXT_CHARS = 2_000;
const MAX_QUESTION_CHARS = 1_000;
const MAX_GREP_SEARCH_CALLS = 3;
const SUBMIT_PLAN_TOOL_NAME = 'submit_plan';
const RETURN_TO_ANSWER_TOOL_NAME = 'return_to_answer';
const DIRECT_TEXT_REASON = 'plan direct text';

const plannerAgentStateSchema = z.object({
  submittedPlan: z.array(z.object({
    capability: z.string(),
    task: z.string(),
  })).nullable().default(null),
});

type SubmittedPlannerTask = {
  capability: string;
  task: string;
};

export type CapabilityPlannerAgentErrorCode =
  | 'planning_limit_reached'
  | 'planning_timeout'
  | 'submission_required';

export class CapabilityPlannerAgentError extends Error {
  readonly code: CapabilityPlannerAgentErrorCode;

  constructor(code: CapabilityPlannerAgentErrorCode, message: string) {
    super(message);
    this.name = 'CapabilityPlannerAgentError';
    this.code = code;
  }
}

function plannerCapabilityNames(input: CapabilityPlannerInput) {
  const availableCapabilityNames = new Set(input.workspace.capabilityNames);
  return [...new Set([
    ...(input.mode === 'boundary'
      ? input.remainingPlan.map((task) => task.capability)
      : []),
    ...input.workspace.capabilityNames,
  ])].filter((name) => availableCapabilityNames.has(name));
}

function createPlannerSubmissionTools(
  input: CapabilityPlannerInput,
): StructuredTool[] {
  const orderedCapabilityNames = plannerCapabilityNames(input);
  const [firstCapabilityName, ...otherCapabilityNames] = orderedCapabilityNames;
  const returnToAnswerTool = tool(
    async ({
      reason,
      context,
      question,
    }: {
      reason: string;
      context: string;
      question?: string;
    }) => JSON.stringify({
      reason,
      context,
      question: question ?? null,
    }),
    {
      name: RETURN_TO_ANSWER_TOOL_NAME,
      description: 'Terminal Planner action. Return planning facts when no executable plan can proceed or user input is required. This does not decide that the user goal is complete and does not send a user-facing reply.',
      schema: z.object({
        reason: z.string().min(1).max(MAX_REASON_CHARS)
          .describe('Why no execution plan should be submitted.'),
        context: z.string().min(1).max(MAX_ANSWER_CONTEXT_CHARS)
          .describe('Facts discovered during planning that Answer may use.'),
        question: z.string().min(1).max(MAX_QUESTION_CHARS).optional()
          .describe('Question Answer should ask the user when more input is needed.'),
      }),
    },
  );
  if (!firstCapabilityName) {
    return [returnToAnswerTool];
  }

  const capabilityNames = [
    firstCapabilityName,
    ...otherCapabilityNames,
  ] as [string, ...string[]];
  const submitPlanTool = tool(
    async ({ tasks }: {
      tasks: Array<{ capability: string; task: string }>;
    }) => {
      if (tasks.some((task, index) =>
        index > 0 && task.capability === tasks[index - 1]?.capability,
      )) {
        throw new Error(
          'Consecutive tasks use the same Capability. Combine them into one complete task.',
        );
      }
      return JSON.stringify({ tasks });
    },
    {
      name: SUBMIT_PLAN_TOOL_NAME,
      description: 'Terminal Planner action. Submit the shortest executable task sequence that completes the user goal.',
      schema: z.object({
        tasks: z.array(z.object({
          capability: z.enum(capabilityNames)
            .describe('Capability that executes this task.'),
          task: z.string().min(1).max(MAX_TASK_TEXT_CHARS)
            .describe('A complete, executable task for that Capability.'),
        })).min(1).max(MAX_PLAN_TASKS)
          .describe('Ordered execution boundaries. The first task runs now; the rest remain planned. Keep continuous work owned by one Capability together in one task.'),
      }),
    },
  );

  return [submitPlanTool, returnToAnswerTool];
}

function readSubmittedPlanTasks(message: ToolMessage): SubmittedPlannerTask[] | null {
  if (message.status === 'error' || typeof message.content !== 'string') {
    return null;
  }
  try {
    const value = JSON.parse(message.content) as { tasks?: unknown };
    if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
      return null;
    }
    const tasks = value.tasks.map((task) => {
      if (!task || typeof task !== 'object') return null;
      const { capability, task: description } = task as {
        capability?: unknown;
        task?: unknown;
      };
      return typeof capability === 'string' && typeof description === 'string'
        ? { capability, task: description }
        : null;
    });
    return tasks.every((task): task is SubmittedPlannerTask => task !== null)
      ? tasks
      : null;
  } catch {
    return null;
  }
}

function buildSubmittedPlanSystemPrompt(tasks: readonly SubmittedPlannerTask[]) {
  return [
    '【计划已完成】submit_plan 已成功提交以下计划：',
    ...tasks.map((task, index) => `${String(index + 1)}. [${task.capability}] ${task.task}`),
    '现在用普通 assistant text 确认以上计划已提交，并结束本轮规划。',
  ].join('\n');
}

function buildGrepSearchLimitSystemPrompt(input: CapabilityPlannerInput) {
  const hasGeneralCapability = plannerCapabilityNames(input).includes('general');
  return [
    '【探索已收束】已完成三次 grep_search。',
    hasGeneralCapability
      ? '现在基于已有的 Capability 信息完成规划：存在可执行的剩余工作时，调用 submit_plan 并使用 general；否则调用 return_to_answer 交回已确认的事实。'
      : '现在调用 return_to_answer，交回已有探索中确认的事实和需要用户决定的部分。',
  ].join('\n');
}

function countGrepSearchToolMessages(messages: readonly BaseMessage[]) {
  const seenToolCallIds = new Set<string>();
  let count = 0;
  for (const message of messages) {
    if (!(message instanceof ToolMessage)
      || message.name !== CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME) {
      continue;
    }
    const identifier = message.tool_call_id || message.id;
    if (identifier && seenToolCallIds.has(identifier)) {
      continue;
    }
    if (identifier) {
      seenToolCallIds.add(identifier);
    }
    count += 1;
  }
  return count;
}

function plannerToolErrorResult(params: {
  name: string;
  args: unknown;
  id?: string;
  error: unknown;
}) {
  const message = params.error instanceof Error
    ? params.error.message
    : String(params.error);
  return new ToolMessage({
    content: `Error invoking tool '${params.name}' with kwargs ${JSON.stringify(params.args)} with error: ${message}\nPlease fix the error and try again.`,
    tool_call_id: params.id ?? '',
    name: params.name,
    status: 'error',
  });
}

/**
 * A successful `submit_plan` stays private to one Capability Planner
 * invocation. `grep_search` is counted from the immutable tool trace, so
 * parallel search calls do not introduce concurrent custom-state updates.
 */
function createPlannerSubmissionStateMiddleware(input: CapabilityPlannerInput) {
  return createMiddleware({
    name: 'CapabilityPlannerSubmissionState',
    stateSchema: plannerAgentStateSchema,
    wrapToolCall: async (request, handler) => {
      let result: ToolMessage | Command;
      try {
        result = await handler(request);
      } catch (error) {
        const errorResult = plannerToolErrorResult({
          name: request.toolCall.name,
          args: request.toolCall.args,
          id: request.toolCall.id,
          error,
        });
        return errorResult;
      }
      if (
        request.toolCall.name !== SUBMIT_PLAN_TOOL_NAME
        || !ToolMessage.isInstance(result)
      ) {
        return result;
      }
      const submittedPlan = readSubmittedPlanTasks(result);
      if (!submittedPlan) {
        return result;
      }
      return new Command({
        update: {
          messages: [result],
          submittedPlan,
        },
      });
    },
    wrapModelCall: (request, handler) => {
      const submittedPlan = request.state.submittedPlan;
      const grepSearchCount = countGrepSearchToolMessages(request.state.messages);
      const systemPrompts = [
        ...(grepSearchCount >= MAX_GREP_SEARCH_CALLS
          ? [buildGrepSearchLimitSystemPrompt(input)]
          : []),
        ...(submittedPlan ? [buildSubmittedPlanSystemPrompt(submittedPlan)] : []),
      ];
      if (systemPrompts.length === 0) {
        return handler(request);
      }
      return handler({
        ...request,
        systemMessage: systemPrompts.reduce(
          (systemMessage, prompt) => systemMessage.concat(prompt),
          request.systemMessage,
        ),
      });
    },
  });
}

function readPlannerSubmission(
  messages: readonly BaseMessage[],
  plannerMessageStart: number,
): CapabilityPlannerResult | null {
  for (const message of [...messages].reverse()) {
    if (!(message instanceof ToolMessage)
      || (message.name !== SUBMIT_PLAN_TOOL_NAME
        && message.name !== RETURN_TO_ANSWER_TOOL_NAME)
      || typeof message.content !== 'string') {
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(message.content);
    } catch {
      // Tool validation errors are also ToolMessages. They are feedback for the
      // model, not a completed planner submission.
      continue;
    }
    if (!value || typeof value !== 'object') continue;

    if (message.name === SUBMIT_PLAN_TOOL_NAME) {
      const tasks = (value as { tasks?: unknown }).tasks;
      if (!Array.isArray(tasks) || tasks.some((task) =>
        !task || typeof task !== 'object'
        || typeof (task as { capability?: unknown }).capability !== 'string'
        || typeof (task as { task?: unknown }).task !== 'string',
      )) {
        continue;
      }
      return {
        tasks: tasks as Array<{ capability: string; task: string }>,
      };
    }

    const {
      reason,
      context,
      question,
    } = value as {
      reason?: unknown;
      context?: unknown;
      question?: unknown;
    };
    if (
      typeof reason === 'string'
      && typeof context === 'string'
      && (typeof question === 'string' || question === null || question === undefined)
    ) {
      return {
        answer: {
          reason,
          context,
          question: typeof question === 'string' ? question : null,
        },
      };
    }
  }

  for (
    let index = messages.length - 1;
    index >= plannerMessageStart;
    index -= 1
  ) {
    const message = messages[index];
    if (!message || message._getType() !== 'ai') continue;
    const text = readMessageText(message);
    if (!text) continue;
    return {
      answer: {
        reason: DIRECT_TEXT_REASON,
        context: text.slice(0, MAX_ANSWER_CONTEXT_CHARS),
        question: null,
      },
    };
  }

  return null;
}

function mergePlannerSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
) {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);
  return {
    signal: parentSignal
      ? AbortSignal.any([parentSignal, timeoutController.signal])
      : timeoutController.signal,
    didTimeOut: () => timedOut,
    dispose: () => clearTimeout(timeout),
  };
}

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function buildPlannerRunnableConfig(params: {
  input: CapabilityPlannerInput;
  runnableConfig?: RunnableConfig;
  signal: AbortSignal;
}): RunnableConfig {
  return {
    ...params.runnableConfig,
    signal: params.signal,
    runName: 'framework.capability_planner',
    tags: [
      ...(params.runnableConfig?.tags ?? []),
      'framework.capability_planner',
    ],
    metadata: {
      ...(params.runnableConfig?.metadata ?? {}),
      frameworkComponent: 'capability_planner',
      registryDigest: params.input.workspace.registryDigest,
      plannerMode: params.input.mode,
    },
  };
}

async function invokePlannerAgent(params: {
  input: CapabilityPlannerInput;
  model: BaseChatModel;
  timeoutMs: number;
  registryBackend: CapabilityRegistryBackend;
  maxDocumentReadBytes?: number;
  runnableConfig?: RunnableConfig;
}): Promise<CapabilityPlannerResult> {
  const explorer = createCapabilityPlannerFileExplorer({
    workspace: params.input.workspace,
    registryBackend: params.registryBackend,
    ...(params.maxDocumentReadBytes
      ? { maxDocumentReadBytes: params.maxDocumentReadBytes }
      : {}),
  });
  const agent = createAgent({
    model: params.model,
    tools: [...explorer.tools, ...createPlannerSubmissionTools(params.input)],
    systemPrompt: buildCapabilityPlannerAgentSystemPrompt(params.input.mode),
    middleware: [createPlannerSubmissionStateMiddleware(params.input)],
  });
  const timeout = mergePlannerSignal(
    params.runnableConfig?.signal,
    params.timeoutMs,
  );
  const runnableConfig = buildPlannerRunnableConfig({
    input: params.input,
    runnableConfig: params.runnableConfig,
    signal: timeout.signal,
  });

  try {
    const messages = [new HumanMessage(buildCapabilityPlannerAgentInput(params.input))];
    timeout.signal.throwIfAborted();
    const result = await agent.invoke({ messages }, runnableConfig);
    // Some providers or callbacks do not stop immediately when their signal is
    // aborted. Never accept a result produced after the deadline.
    timeout.signal.throwIfAborted();

    const submission = readPlannerSubmission(
      result.messages,
      messages.length,
    );
    if (submission) {
      return submission;
    }
    if (explorer.didReachDocumentReadLimit()) {
      throw new CapabilityPlannerAgentError(
        'planning_limit_reached',
        'Capability Planner document read limit was reached before a valid submission.',
      );
    }

    throw new CapabilityPlannerAgentError(
      'submission_required',
      'Capability Planner must finish with a structured planning result.',
    );
  } catch (error) {
    const plannerError = timeout.didTimeOut()
      ? new CapabilityPlannerAgentError(
          'planning_timeout',
          `Capability Planner exceeded its ${String(params.timeoutMs)}ms timeout.`,
        )
      : error;
    throw plannerError;
  } finally {
    timeout.dispose();
  }
}

export function createCapabilityPlannerAgent(params: {
  model: BaseChatModel;
  timeoutMs?: number;
  registryBackend?: CapabilityRegistryBackend;
  maxDocumentReadBytes?: number;
}): CapabilityPlannerRunner {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertPositiveInteger(timeoutMs, 'Capability Planner timeoutMs');
  if (params.maxDocumentReadBytes !== undefined) {
    assertPositiveInteger(
      params.maxDocumentReadBytes,
      'Capability Planner maxDocumentReadBytes',
    );
  }

  return Object.freeze({
    invoke: (
      input: CapabilityPlannerInput,
      runnableConfig?: RunnableConfig,
    ) => invokePlannerAgent({
      input,
      model: params.model,
      timeoutMs,
      registryBackend: params.registryBackend ?? 'filesystem',
      ...(params.maxDocumentReadBytes
        ? { maxDocumentReadBytes: params.maxDocumentReadBytes }
        : {}),
      runnableConfig,
    }),
  });
}
