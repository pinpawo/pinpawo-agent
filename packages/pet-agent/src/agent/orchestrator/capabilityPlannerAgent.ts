import { HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  createAgent,
  createMiddleware,
  toolStrategy,
  type TypedToolStrategy,
} from 'langchain';
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
const MAX_TASK_TEXT_CHARS = 500;
const MAX_REASON_CHARS = 1_000;

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

function createSubmitPlanSchema(capabilityNames: readonly string[]) {
  return {
    title: 'submit_plan',
    description: 'Submit the shortest task sequence that completes the user goal.',
    type: 'object' as const,
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PLAN_TASKS,
        description: 'Ordered tasks. The first task runs now; the rest remain planned.',
        items: {
          type: 'object',
          properties: {
            capability: {
              type: 'string',
              enum: [...capabilityNames],
              description: 'Capability that executes this task.',
            },
            task: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_TASK_TEXT_CHARS,
              description: 'Short, executable task description.',
            },
          },
          required: ['capability', 'task'],
          additionalProperties: false,
        },
      },
    },
    required: ['tasks'],
    additionalProperties: false,
  };
}

const unavailablePlanSchema = {
  title: 'report_unavailable',
  description: 'Report that no Capability can execute the required task.',
  type: 'object' as const,
  properties: {
    task: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TASK_TEXT_CHARS,
      description: 'Task that cannot be executed.',
    },
    reason: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_REASON_CHARS,
      description: 'Why the Capability Workspace cannot execute it.',
    },
  },
  required: ['task', 'reason'],
  additionalProperties: false,
};

function createCapabilityPlannerResponseFormat(
  input: CapabilityPlannerInput,
): TypedToolStrategy<CapabilityPlannerResult> {
  const availableCapabilityNames = new Set(input.workspace.capabilityNames);
  const orderedCapabilityNames = [...new Set([
    ...(input.mode === 'boundary'
      ? input.remainingPlan.map((task) => task.capability)
      : []),
    ...input.workspace.capabilityNames,
  ])].filter((name) => availableCapabilityNames.has(name));
  const [firstCapabilityName, ...otherCapabilityNames] = orderedCapabilityNames;
  if (!firstCapabilityName) {
    return toolStrategy(unavailablePlanSchema, {
      toolMessageContent: 'Capability planning result accepted.',
    }) as TypedToolStrategy<CapabilityPlannerResult>;
  }

  const submitPlanSchema = createSubmitPlanSchema([
    firstCapabilityName,
    ...otherCapabilityNames,
  ]);

  if (orderedCapabilityNames.includes('general')) {
    return toolStrategy(submitPlanSchema, {
      toolMessageContent: 'Capability planning result accepted.',
    }) as TypedToolStrategy<CapabilityPlannerResult>;
  }

  return toolStrategy([
    submitPlanSchema,
    unavailablePlanSchema,
  ], {
    toolMessageContent: 'Capability planning result accepted.',
  }) as TypedToolStrategy<CapabilityPlannerResult>;
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
    systemPrompt: buildCapabilityPlannerAgentSystemPrompt(params.input.mode),
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
          ...params.input.messages,
          ...(params.input.mode === 'boundary'
            ? [new HumanMessage(buildCapabilityPlannerAgentInput(params.input))]
            : []),
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
      result: 'tasks' in structuredResponse ? 'plan' : 'unavailable',
      capabilityName: 'tasks' in structuredResponse
        ? structuredResponse.tasks[0]?.capability ?? null
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
