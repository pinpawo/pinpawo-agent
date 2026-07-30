import { HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  createAgent,
  createMiddleware,
  toolStrategy,
  type TypedToolStrategy,
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

function createPlannerModelMiddleware(maxIterations: number) {
  let modelCalls = 0;
  return createMiddleware({
    name: 'CapabilityPlannerModelBoundary',
    wrapModelCall: (request, handler) => {
      if (modelCalls >= maxIterations) {
        throw new CapabilityPlannerAgentError(
          'planning_limit_reached',
          `Capability Planner exceeded ${String(maxIterations)} model iterations without a valid structured result.`,
        );
      }
      modelCalls += 1;
      return handler({
        ...request,
        modelSettings: {
          ...request.modelSettings,
          parallel_tool_calls: false,
        },
      });
    },
  });
}

const planTaskSchema = z.object({
  objective: z.string().trim().min(1).max(MAX_TASK_TEXT_CHARS)
    .describe('The useful, independently executable result this future task must produce.'),
  capability_intent: z.string().trim().min(1).max(MAX_TASK_TEXT_CHARS)
    .describe('The kind of execution ability the future task will need, without naming a concrete Capability.'),
}).strict();

const unavailablePlanSchema = z.object({
  result: z.literal('unavailable')
    .describe('No Capability in the current workspace can advance the current task.'),
  task: z.string().trim().min(1).max(MAX_TASK_TEXT_CHARS)
    .describe('The current task that cannot be executed.'),
  reason: z.string().trim().min(1).max(MAX_REASON_CHARS)
    .describe('Why no Capability in the current workspace can complete the task.'),
}).strict().describe('Report that the current task cannot be delegated.');

function createCapabilityPlannerResponseFormat(
  input: CapabilityPlannerInput,
): TypedToolStrategy<CapabilityPlannerResult> {
  const [firstCapabilityName, ...otherCapabilityNames] =
    input.workspace.capabilityNames;
  if (!firstCapabilityName) {
    return toolStrategy(unavailablePlanSchema, {
      toolMessageContent: 'Capability planning result accepted.',
    });
  }

  const nextTaskSchema = planTaskSchema.extend({
    capability_name: z.enum([
      firstCapabilityName,
      ...otherCapabilityNames,
    ]).describe(
      'The frontmatter name of the Capability that can complete the whole current task.',
    ),
    context_summary: z.string().trim().max(MAX_TASK_TEXT_CHARS).nullable()
      .describe('Execution context needed by the selected Capability, or null.'),
  }).strict();
  const nextTaskPlanSchema = z.object({
    result: z.literal('next_task')
      .describe('Delegate the current task to a Capability.'),
    next_task: nextTaskSchema
      .describe('The current executable task and selected Capability.'),
    remaining_plan: z.array(planTaskSchema).max(MAX_PLAN_TASKS)
      .describe('Ordered, unstarted future work; use an empty array when none remains.'),
  }).strict().describe('Return the next executable task and future plan tail.');

  return toolStrategy([
    nextTaskPlanSchema,
    unavailablePlanSchema,
  ], {
    toolMessageContent: 'Capability planning result accepted.',
  });
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
  const agent = createAgent({
    model: params.model,
    tools: [...explorer.tools],
    systemPrompt: buildCapabilityPlannerAgentSystemPrompt(),
    middleware: [createPlannerModelMiddleware(params.maxIterations)],
    responseFormat: createCapabilityPlannerResponseFormat(params.input),
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
    const result = await agent.invoke(
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

    const structuredResponse = result.structuredResponse;
    if (!structuredResponse) {
      if (explorer.hasReachedObservationLimit()) {
        throw new CapabilityPlannerAgentError(
          'planning_limit_reached',
          'Capability Planner document observation budget was reached before a valid submission.',
        );
      }
      throw new CapabilityPlannerAgentError(
        'submission_required',
        'Capability Planner must finish with a structured planning result.',
      );
    }

    emitPlannerEvent({
      phase: 'complete',
      mode: params.input.mode,
      registryDigest: params.input.workspace.registryDigest,
      observationBudget: explorer.getObservationBudget(),
      result: structuredResponse.result,
      capabilityName: structuredResponse.result === 'next_task'
        ? structuredResponse.next_task.capability_name
        : null,
    });
    return structuredResponse;
  } catch (error) {
    const middlewareCause = error instanceof Error
      && error.cause instanceof CapabilityPlannerAgentError
      ? error.cause
      : null;
    const plannerError = timeout.didTimeOut()
      ? new CapabilityPlannerAgentError(
          'planning_timeout',
          `Capability Planner exceeded its ${String(params.timeoutMs)}ms timeout.`,
        )
      : middlewareCause ?? error;
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
