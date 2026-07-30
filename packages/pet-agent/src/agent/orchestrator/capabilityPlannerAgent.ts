import { HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool, type ClientTool } from '@langchain/core/tools';
import { Command, END } from '@langchain/langgraph';
import {
  createAgent,
  createMiddleware,
  modelCallLimitMiddleware,
  type AnyAgentMiddleware,
} from 'langchain';
import { z } from 'zod';
import { emitRuntimeEventToStreamWriter } from '../../utils/streamWriterEvents';
import { createCapabilityPlannerFileExplorer } from './capabilityPlannerFileExplorer';
import {
  buildCapabilityPlannerAgentInput,
  buildCapabilityPlannerAgentSystemPrompt,
} from './prompts/capabilityPlannerAgent';
import type {
  CapabilityPlannerInput,
  CapabilityPlannerResult,
  CapabilityPlannerRunner,
} from './capabilityPlannerRunner';

export const CAPABILITY_PLANNER_SUBMIT_TOOL_NAME = 'submit_capability_plan';
export const CAPABILITY_PLANNER_RUNTIME_EVENT = 'capability_planner_agent';

const DEFAULT_MAX_MODEL_ITERATIONS = 12;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PLAN_TASKS = 24;
const MAX_TASK_TEXT_CHARS = 8_000;
const MAX_REASON_CHARS = 4_000;

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

type SubmitToolState = {
  result: CapabilityPlannerResult | null;
};

const singleToolCallMiddleware = createMiddleware({
  name: 'CapabilityPlannerSingleToolCall',
  wrapModelCall: (request, handler) => handler({
    ...request,
    modelSettings: {
      ...request.modelSettings,
      parallel_tool_calls: false,
    },
  }),
});

const planTaskSchema = z.object({
  objective: z.string().trim().min(1).max(MAX_TASK_TEXT_CHARS)
    .describe('The useful, independently executable result this future task must produce.'),
  capability_intent: z.string().trim().min(1).max(MAX_TASK_TEXT_CHARS)
    .describe('The kind of execution ability the future task will need, without naming a concrete Capability.'),
}).strict();

const nextTaskSchema = planTaskSchema.extend({
  capability_name: z.string().trim().min(1).max(128)
    .describe('The frontmatter name from an observed CAPABILITY.md that can complete the whole current task.'),
  context_summary: z.string().trim().max(MAX_TASK_TEXT_CHARS).nullable()
    .describe('Execution context needed by the selected Capability, or null when no additional context is needed.'),
}).strict();

const submitCapabilityPlanSchema = z.object({
  result: z.enum(['next_task', 'unavailable'])
    .describe('Whether to delegate the current task or report it unavailable.'),
  next_task: nextTaskSchema.optional()
    .describe('The structured current executable task object, not a JSON-encoded string. Required only for result=next_task.'),
  remaining_plan: z.array(planTaskSchema).max(MAX_PLAN_TASKS).optional()
    .describe('Ordered, unstarted future work. It is empty for unavailable.'),
  task: z.string().trim().min(1).max(MAX_TASK_TEXT_CHARS).optional()
    .describe('The current task that cannot be executed. Required only for result=unavailable.'),
  reason: z.string().trim().min(1).max(MAX_REASON_CHARS).optional()
    .describe('Why no Capability in the current registry can complete the unavailable task.'),
}).strict().superRefine((submission, ctx) => {
  if (submission.result === 'next_task') {
    if (!submission.next_task) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['next_task'],
        message: 'result=next_task requires next_task.',
      });
    }
    if (submission.task || submission.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['task'],
        message: 'result=next_task must not include task or reason.',
      });
    }
  }
  if (submission.result === 'unavailable') {
    if (!submission.task || !submission.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['task'],
        message: 'result=unavailable requires task and reason.',
      });
    }
    if (submission.next_task || (submission.remaining_plan?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remaining_plan'],
        message: 'result=unavailable must not include next_task or remaining_plan.',
      });
    }
  }
});

function plannerToolError(
  code: string,
  message: string,
) {
  return JSON.stringify({
    ok: false,
    tool: CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
    error: { code, message },
  });
}

function validateSubmission(params: {
  input: CapabilityPlannerInput;
  submission: z.infer<typeof submitCapabilityPlanSchema>;
}): { result: CapabilityPlannerResult } | { code: string; message: string } {
  const { input, submission } = params;

  if (submission.result === 'unavailable') {
    return {
      result: {
        result: 'unavailable',
        task: submission.task as string,
        reason: submission.reason as string,
      },
    };
  }

  const nextTask = submission.next_task;
  if (!nextTask) {
    return {
      code: 'invalid_plan',
      message: 'next_task submission is missing next_task.',
    };
  }
  const workspaceEntry = input.workspace.entries.find(
    (entry) => entry.capabilityName === nextTask.capability_name,
  );
  if (!workspaceEntry) {
    return {
      code: 'unknown_capability',
      message: 'capability_name is not present in this Capability Document Workspace.',
    };
  }
  const remainingPlan = submission.remaining_plan ?? [];
  return {
    result: {
      result: 'next_task',
      next_task: {
        objective: nextTask.objective,
        capability_intent: nextTask.capability_intent,
        capability_name: nextTask.capability_name,
        context_summary: nextTask.context_summary,
      },
      remaining_plan: remainingPlan,
    },
  };
}

function createSubmitCapabilityPlanTool(params: {
  input: CapabilityPlannerInput;
  state: SubmitToolState;
}) {
  return tool(
    async (submission) => {
      const validated = validateSubmission({
        input: params.input,
        submission,
      });
      if (!('result' in validated)) {
        return plannerToolError(validated.code, validated.message);
      }
      params.state.result = validated.result;
      return new Command({ goto: END });
    },
    {
      name: CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
      description: 'Submit the terminal Capability planning result. A valid submission ends planning; an unknown capability_name returns feedback for correction.',
      schema: submitCapabilityPlanSchema,
    },
  );
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

function emitPlannerEvent(data: unknown) {
  emitRuntimeEventToStreamWriter({
    event: 'on_runtime_event',
    name: CAPABILITY_PLANNER_RUNTIME_EVENT,
    data,
  });
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
  maxIterations: number;
  timeoutMs: number;
  maxObservationBytes?: number;
  runnableConfig?: RunnableConfig;
}): Promise<CapabilityPlannerResult> {
  const explorer = createCapabilityPlannerFileExplorer({
    workspace: params.input.workspace,
    ...(params.maxObservationBytes
      ? { maxObservationBytes: params.maxObservationBytes }
      : {}),
  });
  const submitState: SubmitToolState = { result: null };
  const submitTool = createSubmitCapabilityPlanTool({
    input: params.input,
    state: submitState,
  });
  const tools: ClientTool[] = [...explorer.tools, submitTool];
  const middleware: AnyAgentMiddleware[] = [
    singleToolCallMiddleware,
    modelCallLimitMiddleware({
      runLimit: params.maxIterations,
      exitBehavior: 'error',
    }),
  ];
  const agent = createAgent({
    model: params.model,
    tools,
    systemPrompt: buildCapabilityPlannerAgentSystemPrompt(),
    middleware,
    responseFormat: undefined,
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

  emitPlannerEvent({
    phase: 'start',
    mode: params.input.mode,
    registryDigest: params.input.workspace.registryDigest,
    documentCount: params.input.workspace.entries.length,
    maxIterations: params.maxIterations,
    maxObservationBytes:
      explorer.getObservationBudget().maxDocumentBytes,
  });

  try {
    timeout.signal.throwIfAborted();
    await agent.invoke(
      {
        messages: [
          new HumanMessage(buildCapabilityPlannerAgentInput(params.input)),
        ],
      },
      {
        ...runnableConfig,
        recursionLimit: Math.max(
          runnableConfig.recursionLimit ?? 0,
          params.maxIterations * 10 + 10,
        ),
      },
    );
    // Some providers or callbacks do not stop immediately when their signal is
    // aborted. Never accept a result produced after the deadline.
    timeout.signal.throwIfAborted();

    if (!submitState.result) {
      if (explorer.hasReachedObservationLimit()) {
        throw new CapabilityPlannerAgentError(
          'planning_limit_reached',
          'Capability Planner document observation budget was reached before a valid submission.',
        );
      }
      throw new CapabilityPlannerAgentError(
        'submission_required',
        `Capability Planner must finish with ${CAPABILITY_PLANNER_SUBMIT_TOOL_NAME}.`,
      );
    }

    emitPlannerEvent({
      phase: 'complete',
      mode: params.input.mode,
      registryDigest: params.input.workspace.registryDigest,
      observationBudget: explorer.getObservationBudget(),
      result: submitState.result.result,
      capabilityName: submitState.result.result === 'next_task'
        ? submitState.result.next_task.capability_name
        : null,
    });
    return submitState.result;
  } catch (error) {
    const plannerError = timeout.didTimeOut()
      ? new CapabilityPlannerAgentError(
          'planning_timeout',
          `Capability Planner exceeded its ${String(params.timeoutMs)}ms timeout.`,
        )
      : error instanceof Error
        && error.name === 'ModelCallLimitMiddlewareError'
        ? new CapabilityPlannerAgentError(
            'planning_limit_reached',
            `Capability Planner exceeded ${String(params.maxIterations)} model iterations without a valid submission.`,
          )
      : error;
    emitPlannerEvent({
      phase: 'error',
      mode: params.input.mode,
      registryDigest: params.input.workspace.registryDigest,
      observationBudget: explorer.getObservationBudget(),
      errorCode: plannerError instanceof CapabilityPlannerAgentError
        ? plannerError.code
        : 'planner_failed',
    });
    throw plannerError;
  } finally {
    timeout.dispose();
  }
}

export function createCapabilityPlannerAgent(params: {
  model: BaseChatModel;
  maxIterations?: number;
  timeoutMs?: number;
  maxObservationBytes?: number;
}): CapabilityPlannerRunner {
  const maxIterations = params.maxIterations ?? DEFAULT_MAX_MODEL_ITERATIONS;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertPositiveInteger(maxIterations, 'Capability Planner maxIterations');
  assertPositiveInteger(timeoutMs, 'Capability Planner timeoutMs');
  if (params.maxObservationBytes !== undefined) {
    assertPositiveInteger(
      params.maxObservationBytes,
      'Capability Planner maxObservationBytes',
    );
  }

  return Object.freeze({
    invoke: (
      input: CapabilityPlannerInput,
      runnableConfig?: RunnableConfig,
    ) => invokePlannerAgent({
      input,
      model: params.model,
      maxIterations,
      timeoutMs,
      ...(params.maxObservationBytes
        ? { maxObservationBytes: params.maxObservationBytes }
        : {}),
      runnableConfig,
    }),
  });
}
