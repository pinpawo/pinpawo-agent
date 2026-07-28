import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool, type StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { GENERAL_CAPABILITY_NAME } from '../../types/capability';
import { emitRuntimeEventToStreamWriter } from '../../utils/streamWriterEvents';
import { readMessageToolCalls } from '../../utils/messages';
import {
  createCapabilityPlannerFileExplorer,
  CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
  CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
} from './capabilityPlannerFileExplorer';
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
  | 'submission_required'
  | 'tool_calling_unavailable';

export class CapabilityPlannerAgentError extends Error {
  readonly code: CapabilityPlannerAgentErrorCode;

  constructor(code: CapabilityPlannerAgentErrorCode, message: string) {
    super(message);
    this.name = 'CapabilityPlannerAgentError';
    this.code = code;
  }
}

type PlannerToolCallingModel = {
  bindTools: (tools: StructuredTool[]) => {
    invoke: (
      messages: BaseMessage[],
      runnableConfig?: RunnableConfig,
    ) => Promise<BaseMessage>;
  };
};

type PlannerLoopMetrics = {
  modelIterations: number;
  toolCalls: number;
  observedDocumentPaths: Set<string>;
};

type SubmitToolState = {
  result: CapabilityPlannerResult | null;
};

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
  registry_digest: z.string().trim().min(1)
    .describe('The exact registry_digest from the immutable workspace input.'),
  result: z.enum(['next_task', 'unavailable'])
    .describe('next_task delegates current work; unavailable is allowed only when no registered Capability, including general, can execute the current task.'),
  next_task: nextTaskSchema.nullable().optional()
    .describe('The current executable task. Required only for result=next_task.'),
  remaining_plan: z.array(planTaskSchema).max(MAX_PLAN_TASKS).optional()
    .describe('Ordered, unstarted future work. It is empty for unavailable.'),
  task: z.string().trim().min(1).max(MAX_TASK_TEXT_CHARS).nullable().optional()
    .describe('The current task that cannot be executed. Required only for result=unavailable.'),
  reason: z.string().trim().min(1).max(MAX_REASON_CHARS).nullable().optional()
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
  input: CapabilityPlannerInput,
  code: string,
  message: string,
) {
  return JSON.stringify({
    ok: false,
    tool: CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
    registryDigest: input.workspace.registryDigest,
    error: { code, message },
  });
}

function plannerToolSuccess(
  input: CapabilityPlannerInput,
  result: CapabilityPlannerResult,
) {
  return JSON.stringify({
    ok: true,
    tool: CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
    registryDigest: input.workspace.registryDigest,
    data: {
      accepted: true,
      result: result.result,
      capabilityName:
        result.result === 'next_task' ? result.next_task.capability_name : null,
    },
  });
}

function freezePlannerResult(
  result: CapabilityPlannerResult,
): CapabilityPlannerResult {
  if (result.result === 'next_task') {
    return Object.freeze({
      result: 'next_task',
      next_task: Object.freeze({ ...result.next_task }),
      remaining_plan: Object.freeze(
        result.remaining_plan.map((task) => Object.freeze({ ...task })),
      ),
    });
  }
  return Object.freeze({ ...result });
}

function validateSubmission(params: {
  input: CapabilityPlannerInput;
  submission: z.infer<typeof submitCapabilityPlanSchema>;
  observedDocumentPaths: ReadonlySet<string>;
}): { result: CapabilityPlannerResult } | { code: string; message: string } {
  const { input, submission } = params;
  if (submission.registry_digest !== input.workspace.registryDigest) {
    return {
      code: 'registry_mismatch',
      message: 'registry_digest does not match the immutable workspace for this run.',
    };
  }

  if (submission.result === 'unavailable') {
    const task = submission.task as string;
    if (input.workspace.capabilityNames.includes(GENERAL_CAPABILITY_NAME)) {
      return {
        code: 'general_fallback_required',
        message: 'The general Capability is registered. Read its CAPABILITY.md and submit next_task with capability_name=general.',
      };
    }
    if (
      input.workspace.entries.length > 0
      && params.observedDocumentPaths.size === 0
    ) {
      return {
        code: 'capability_not_observed',
        message: 'Explore Capability documents before declaring a non-empty workspace unavailable.',
      };
    }
    return {
      result: freezePlannerResult({
        result: 'unavailable',
        task,
        reason: submission.reason as string,
      }),
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
  if (!params.observedDocumentPaths.has(workspaceEntry.relativePath)) {
    return {
      code: 'capability_not_observed',
      message: 'Read or grep the selected Capability document before submitting it.',
    };
  }
  const remainingPlan = submission.remaining_plan ?? [];
  if (remainingPlan.some((task) =>
    task.objective === nextTask.objective
    && task.capability_intent === nextTask.capability_intent)) {
    return {
      code: 'invalid_plan',
      message: 'remaining_plan must not repeat next_task.',
    };
  }
  return {
    result: freezePlannerResult({
      result: 'next_task',
      next_task: {
        objective: nextTask.objective,
        capability_intent: nextTask.capability_intent,
        capability_name: nextTask.capability_name,
        context_summary: nextTask.context_summary,
      },
      remaining_plan: remainingPlan,
    }),
  };
}

function createSubmitCapabilityPlanTool(params: {
  input: CapabilityPlannerInput;
  state: SubmitToolState;
  observedDocumentPaths: ReadonlySet<string>;
  observationLimitReached: () => boolean;
}) {
  return tool(
    async (submission) => {
      if (params.observationLimitReached()) {
        return plannerToolError(
          params.input,
          'planning_limit_reached',
          'Capability Planner document observation budget was reached; no plan was accepted.',
        );
      }
      if (params.state.result) {
        return plannerToolError(
          params.input,
          'duplicate_submission',
          'A planning result has already been accepted.',
        );
      }
      const validated = validateSubmission({
        input: params.input,
        submission,
        observedDocumentPaths: params.observedDocumentPaths,
      });
      if (!('result' in validated)) {
        return plannerToolError(params.input, validated.code, validated.message);
      }
      params.state.result = validated.result;
      return plannerToolSuccess(params.input, validated.result);
    },
    {
      name: CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
      description: 'Submit the sole terminal Capability planning result for the current immutable workspace. Invalid submissions return a structured error so they can be corrected.',
      schema: submitCapabilityPlanSchema,
    },
  );
}

function bindPlannerTools(model: BaseChatModel, tools: StructuredTool[]) {
  const candidate = model as BaseChatModel & Partial<PlannerToolCallingModel>;
  if (typeof candidate.bindTools !== 'function') {
    throw new CapabilityPlannerAgentError(
      'tool_calling_unavailable',
      'Capability Planner model does not support private tool binding.',
    );
  }
  return candidate.bindTools(tools);
}

function stableToolOutput(output: unknown) {
  if (typeof output === 'string') return output;
  if (output instanceof ToolMessage) {
    return typeof output.content === 'string'
      ? output.content
      : JSON.stringify(output.content);
  }
  return JSON.stringify(output);
}

function stableToolInvocationError(toolName: string, error: unknown) {
  return JSON.stringify({
    ok: false,
    tool: toolName,
    error: {
      code: 'invalid_arguments',
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function recordObservedDocumentPaths(
  toolName: string,
  output: string,
  observedDocumentPaths: Set<string>,
) {
  if (
    toolName !== CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME
    && toolName !== CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME
  ) {
    return;
  }
  try {
    const parsed = JSON.parse(output) as {
      ok?: unknown;
      data?: {
        path?: unknown;
        matches?: Array<{ path?: unknown }>;
      };
    };
    if (parsed.ok !== true) return;
    if (typeof parsed.data?.path === 'string') {
      observedDocumentPaths.add(parsed.data.path);
    }
    for (const match of parsed.data?.matches ?? []) {
      if (typeof match.path === 'string') {
        observedDocumentPaths.add(match.path);
      }
    }
  } catch {
    // Tool output is framework-owned JSON. Treat malformed output as no
    // observation; submit validation will require another successful read.
  }
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
  timeout.unref();
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

async function invokePlannerLoop(params: {
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
  const metrics: PlannerLoopMetrics = {
    modelIterations: 0,
    toolCalls: 0,
    observedDocumentPaths: new Set<string>(),
  };
  const submitState: SubmitToolState = { result: null };
  const submitTool = createSubmitCapabilityPlanTool({
    input: params.input,
    state: submitState,
    observedDocumentPaths: metrics.observedDocumentPaths,
    observationLimitReached: explorer.hasReachedObservationLimit,
  });
  const tools: StructuredTool[] = [...explorer.tools, submitTool];
  const toolsByName = new Map(tools.map((plannerTool) => [
    plannerTool.name,
    plannerTool,
  ]));
  const model = bindPlannerTools(params.model, tools);
  const timeout = mergePlannerSignal(
    params.runnableConfig?.signal,
    params.timeoutMs,
  );
  const runnableConfig = buildPlannerRunnableConfig({
    input: params.input,
    runnableConfig: params.runnableConfig,
    signal: timeout.signal,
  });
  const messages: BaseMessage[] = [
    new SystemMessage(buildCapabilityPlannerAgentSystemPrompt()),
    new HumanMessage(buildCapabilityPlannerAgentInput(params.input)),
  ];

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
    for (
      let iteration = 1;
      iteration <= params.maxIterations;
      iteration += 1
    ) {
      timeout.signal.throwIfAborted();
      metrics.modelIterations = iteration;
      const response = await model.invoke(messages, runnableConfig);
      if (response._getType() !== 'ai') {
        throw new CapabilityPlannerAgentError(
          'submission_required',
          'Capability Planner model returned a non-AI message.',
        );
      }
      const aiResponse = response as AIMessage;
      messages.push(aiResponse);
      const toolCalls = readMessageToolCalls(aiResponse, {
        fallbackIdPrefix: `capability_planner:${String(iteration)}`,
      });
      if (toolCalls.length === 0) {
        throw new CapabilityPlannerAgentError(
          'submission_required',
          `Capability Planner must finish with ${CAPABILITY_PLANNER_SUBMIT_TOOL_NAME}.`,
        );
      }

      for (const toolCall of toolCalls) {
        timeout.signal.throwIfAborted();
        metrics.toolCalls += 1;
        const plannerTool = toolsByName.get(toolCall.name);
        let output: string;
        if (!plannerTool) {
          output = JSON.stringify({
            ok: false,
            tool: toolCall.name,
            error: {
              code: 'unknown_tool',
              message: `Unknown Planner tool "${toolCall.name}".`,
            },
          });
        } else {
          try {
            output = stableToolOutput(await plannerTool.invoke(
              {
                id: toolCall.id,
                name: toolCall.name,
                args: toolCall.args,
                type: 'tool_call',
              } as never,
              runnableConfig,
            ));
          } catch (error) {
            output = stableToolInvocationError(toolCall.name, error);
          }
        }
        // A tool or an async tracing callback may outlive the deadline even
        // when it ignores the provided signal. Never accept a submission that
        // completed after the Planner timeout or parent cancellation.
        timeout.signal.throwIfAborted();
        recordObservedDocumentPaths(
          toolCall.name,
          output,
          metrics.observedDocumentPaths,
        );
        messages.push(new ToolMessage({
          name: toolCall.name,
          content: output,
          tool_call_id: toolCall.id,
        }));

        if (submitState.result) {
          emitPlannerEvent({
            phase: 'complete',
            mode: params.input.mode,
            registryDigest: params.input.workspace.registryDigest,
            modelIterations: metrics.modelIterations,
            toolCalls: metrics.toolCalls,
            observedDocumentPaths: [...metrics.observedDocumentPaths].sort(),
            observationBudget: explorer.getObservationBudget(),
            result: submitState.result.result,
            capabilityName: submitState.result.result === 'next_task'
              ? submitState.result.next_task.capability_name
              : null,
          });
          return submitState.result;
        }
        if (explorer.hasReachedObservationLimit()) {
          throw new CapabilityPlannerAgentError(
            'planning_limit_reached',
            'Capability Planner document observation budget was reached before a valid submission.',
          );
        }
      }
    }

    throw new CapabilityPlannerAgentError(
      'planning_limit_reached',
      `Capability Planner exceeded ${String(params.maxIterations)} model iterations without a valid submission.`,
    );
  } catch (error) {
    const plannerError = timeout.didTimeOut()
      ? new CapabilityPlannerAgentError(
          'planning_timeout',
          `Capability Planner exceeded its ${String(params.timeoutMs)}ms timeout.`,
        )
      : error;
    emitPlannerEvent({
      phase: 'error',
      mode: params.input.mode,
      registryDigest: params.input.workspace.registryDigest,
      modelIterations: metrics.modelIterations,
      toolCalls: metrics.toolCalls,
      observedDocumentPaths: [...metrics.observedDocumentPaths].sort(),
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
    ) => invokePlannerLoop({
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
