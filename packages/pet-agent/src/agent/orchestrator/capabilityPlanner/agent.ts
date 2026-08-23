import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool, type StructuredTool } from '@langchain/core/tools';
import { Command, END } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import {
  createAgent,
  createMiddleware,
} from 'langchain';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import {
  CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
  createCapabilityPlannerFileExplorer,
  createCapabilityPlannerSearchTool,
  type CapabilityPlannerDefaultCapability,
  type CapabilityPlannerFileExplorer,
  type CapabilityPlannerSearchResult,
} from './fileExplorer';
import type { CapabilityRegistryBackend } from './registryDocuments';
import {
  buildCapabilityPlannerAgentInput,
  buildCapabilityPlannerAgentSystemPrompt,
} from '../prompts/capabilityPlannerAgent';
import type {
  CapabilityPlannerInput,
  CapabilityPlannerResult,
  CapabilityPlannerRunner,
} from './runner';
import {
  parsePlannerCommit,
  type PlannerCommit,
} from './protocol';
import {
  CAPABILITY_PLANNER_MESSAGE_SOURCE,
  isCapabilityPlannerMessage,
  selectCapabilityPlannerMessages,
} from './messageContext';
import {
  getPinpetMeta,
  setPinpetMeta,
  stampMessageCreatedAtUtc,
} from '../messageLanes';
import { projectDelegationAnnouncesForModel } from '../delegationAnnounce';

const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_CAPABILITY_PLANNER_MAX_SEARCH_ROUNDS = 2;
const MAX_CAPABILITY_DISCOVERY_HINTS = 50;
const MAX_PLAN_TASKS = 24;
const MAX_TASK_TEXT_CHARS = 2_000;
const CONTINUE_CURRENT_TOOL_NAME = 'continue_current';
const SUBMIT_PLAN_TOOL_NAME = 'submit_plan';
const ADVANCE_PLAN_TOOL_NAME = 'advance_plan';
const COMPLETE_GOAL_TOOL_NAME = 'complete_goal';
const REQUEST_USER_INPUT_TOOL_NAME = 'request_user_input';
const REPORT_UNAVAILABLE_TOOL_NAME = 'report_unavailable';

const plannerInvocationStateSchema = z4.object({
  currentInput: z4.custom<CapabilityPlannerInput>(),
  defaultCapability: z4.custom<CapabilityPlannerDefaultCapability | null>().default(null),
  plannerCommit: z4.custom<PlannerCommit>().nullable().default(null),
});

type PlannerInvocationState = z4.infer<typeof plannerInvocationStateSchema>;
type PlannerSearchToolState = Pick<
  PlannerInvocationState,
  'currentInput' | 'defaultCapability'
> & {
  messages?: BaseMessage[];
};

export type CapabilityPlannerAgentErrorCode =
  | 'planning_limit_reached'
  | 'planning_timeout';

export class CapabilityPlannerAgentError extends Error {
  readonly code: CapabilityPlannerAgentErrorCode;

  constructor(code: CapabilityPlannerAgentErrorCode, message: string) {
    super(message);
    this.name = 'CapabilityPlannerAgentError';
    this.code = code;
  }
}

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

/**
 * Terminal tools serialize an already-made decision. Their descriptions define
 * the commit shape and structural affordances, not planning policy.
 */
function createPlannerTerminalTools(): StructuredTool[] {
  const continueCurrent = tool(
    async () => JSON.stringify({ action: 'continue_current', tasks: [] }),
    {
      name: CONTINUE_CURRENT_TOOL_NAME,
      description: 'Submit continue_current with no tasks.',
      schema: z.object({}).strict(),
    },
  );
  const submitPlan = tool(
    async ({ tasks }: { tasks: Array<{ capability: string; task: string }> }) => {
      return JSON.stringify({ action: 'execute_plan', tasks });
    },
    {
      name: SUBMIT_PLAN_TOOL_NAME,
      description: 'Submit execute_plan with the initial ordered tasks.',
      schema: z.object({ tasks: plannerTasksSchema() }),
    },
  );
  const advancePlan = tool(
    async ({ tasks }: { tasks: Array<{ capability: string; task: string }> }) => {
      return JSON.stringify({ action: 'advance_plan', tasks });
    },
    {
      name: ADVANCE_PLAN_TOOL_NAME,
      description: 'Submit advance_plan with the ordered remaining tasks.',
      schema: z.object({ tasks: plannerTasksSchema() }),
    },
  );
  const completeGoal = tool(
    async () => JSON.stringify({ action: 'goal_done', tasks: [] }),
    {
      name: COMPLETE_GOAL_TOOL_NAME,
      description: 'Submit goal_done with no tasks.',
      schema: z.object({}).strict(),
    },
  );
  const requestUserInput = tool(
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
  );
  const reportUnavailable = tool(
    async () => JSON.stringify({ action: 'unavailable', tasks: [] }),
    {
      name: REPORT_UNAVAILABLE_TOOL_NAME,
      description: 'Submit unavailable with no tasks.',
      schema: z.object({}).strict(),
    },
  );
  return [
    continueCurrent,
    submitPlan,
    advancePlan,
    completeGoal,
    requestUserInput,
    reportUnavailable,
  ];
}

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

/**
 * Stamp Planner-lane provenance onto a message, in place.
 *
 * Callers must only pass messages this invocation produced. The `produced`
 * filter in buildPlannerMessageUpdates() is what guarantees that: it drops any
 * message still referenced by, or sharing an id with, `input.messages`, so a
 * message already committed to root state is never mutated here.
 */
function stampPlannerMessage(params: {
  message: BaseMessage;
  input: CapabilityPlannerInput;
}) {
  const { message, input } = params;
  if (!message.id) message.id = randomUUID();
  stampMessageCreatedAtUtc(message);
  setPinpetMeta(message, {
    lane: 'orchestrator',
    source: CAPABILITY_PLANNER_MESSAGE_SOURCE,
    traceId: input.traceId,
    runId: input.runId,
    plannerInputId: input.inputId,
    registryDigest: input.workspace.registryDigest,
  });
  return message;
}

function readCachedPlannerCommit(input: CapabilityPlannerInput) {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    const meta = getPinpetMeta(message);
    if (!ToolMessage.isInstance(message)
      || !isCapabilityPlannerMessage(message, input.traceId)
      || meta.registryDigest !== input.workspace.registryDigest
      || meta.plannerInputId !== input.inputId) {
      continue;
    }
    const rawCommit = readTerminalCommit(message);
    if (rawCommit) return rawCommit;
  }
  return null;
}

/**
 * The single source of the validation context for this invocation. Every
 * parsePlannerCommit() call inside the agent — live commit, replayed commit and
 * mid-run tool validation — must agree on mode, active delegation and allowed
 * capabilities, so they all derive it from here.
 */
function plannerCommitContext(input: CapabilityPlannerInput) {
  return {
    mode: input.mode,
    activeDelegation: input.activeDelegation,
    allowedCapabilityNames: input.workspace.capabilityNames,
  };
}

function buildPlannerMessageUpdates(params: {
  input: CapabilityPlannerInput;
  resultMessages: readonly BaseMessage[];
}) {
  const rootRefs = new Set(params.input.messages);
  const rootIds = new Set(params.input.messages.flatMap((message) =>
    message.id ? [message.id] : [],
  ));
  const produced = params.resultMessages.filter((message) =>
    !rootRefs.has(message) && (!message.id || !rootIds.has(message.id)),
  );
  const stalePlannerRemovals = params.input.messages.flatMap((message) => {
    if (!isCapabilityPlannerMessage(message)) return [];
    const meta = getPinpetMeta(message);
    if (meta.traceId === params.input.traceId
      && meta.registryDigest === params.input.workspace.registryDigest) {
      return [];
    }
    return message.id ? [new RemoveMessage({ id: message.id }) as BaseMessage] : [];
  });
  return [
    ...stalePlannerRemovals,
    ...produced.map((message) => stampPlannerMessage({ message, input: params.input })),
  ];
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
      traceId: params.input.traceId,
      runId: params.input.runId,
      plannerInputId: params.input.inputId,
      registryDigest: params.input.workspace.registryDigest,
      plannerMode: params.input.mode,
    },
  };
}

function currentPlannerInput(state: Partial<PlannerInvocationState>) {
  if (!state.currentInput) {
    throw new Error('Planner invocation state has no current input.');
  }
  return state.currentInput;
}

type CapabilityExplorationState = {
  status: 'open' | 'closed';
  /** Search rounds that were allowed to disclose Capability documents. */
  roundsUsed: number;
  /** All model rounds containing capability_search, including over-limit attempts. */
  attemptedRounds: number;
  maxRounds: number;
};

function capabilityExplorationState(
  state: Partial<PlannerInvocationState> & { messages?: BaseMessage[] },
  maxRounds: number,
): CapabilityExplorationState {
  const input = currentPlannerInput(state);
  const inputMessageId = `planner:${input.inputId}`;
  let inputIndex = -1;
  for (let index = (state.messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    if (state.messages?.[index]?.id === inputMessageId) {
      inputIndex = index;
      break;
    }
  }
  const attemptedRounds = inputIndex < 0
    ? 0
    : state.messages?.slice(inputIndex + 1).filter((message) =>
        AIMessage.isInstance(message)
        && message.tool_calls?.some((toolCall) =>
          toolCall.name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME))
      .length ?? 0;
  const roundsUsed = Math.min(attemptedRounds, maxRounds);
  return {
    status: roundsUsed >= maxRounds ? 'closed' : 'open',
    roundsUsed,
    attemptedRounds,
    maxRounds,
  };
}

type CapabilitySearchLimitResult = {
  readonly ok: false;
  readonly error: {
    readonly code: 'capability_search_round_limit_exceeded';
    readonly message: string;
  };
};

type CapabilitySearchExecutionResult =
  | CapabilityPlannerSearchResult
  | CapabilitySearchLimitResult;

function capabilitySearchLimitExceeded(
  exploration: CapabilityExplorationState,
): CapabilitySearchLimitResult {
  return {
    ok: false,
    error: {
      code: 'capability_search_round_limit_exceeded',
      message: `Capability search limit exceeded after ${exploration.maxRounds.toString()} rounds. No search was executed and no new Capability documents were disclosed. Finish planning from the Capability documents and facts already available.`,
    },
  };
}

function capabilitySearchPlanningGuidance(params: {
  input: CapabilityPlannerInput;
  defaultCandidate: string | null;
  matchedCandidates: readonly string[];
  nextSearchCandidates: readonly string[];
  successfulSpecificMiss: boolean;
  limitExceeded: boolean;
}) {
  const {
    input,
    defaultCandidate,
    matchedCandidates,
    nextSearchCandidates,
    successfulSpecificMiss,
    limitExceeded,
  } = params;
  if (input.mode === 'boundary') {
    const activeCapability = input.activeDelegation.capability;
    return {
      objective: 'stably_advance_existing_plan' as const,
      activeCapability,
      activeCapabilityMatched: activeCapability !== null
        && matchedCandidates.includes(activeCapability),
      capabilityMatchMeaning: 'candidate_document_not_new_task_assignment' as const,
      continueCurrentWhen: 'current_task_still_has_executable_work' as const,
      changePlanWhen: 'latest_evidence_requires_a_minimal_change' as const,
      continueSearchCandidates: nextSearchCandidates,
      reportUnavailableWhen: 'unfinished_goal_has_no_executable_path' as const,
    };
  }
  if (!successfulSpecificMiss && !limitExceeded) return null;
  return {
    objective: 'select_most_specific_capability_for_current_request' as const,
    defaultCandidate,
    ...(defaultCandidate
      ? {
          useDefaultWhen: 'no_more_specific_candidate_can_better_deliver_current_request' as const,
        }
      : {}),
    continueSearchCandidates: nextSearchCandidates,
    reportUnavailableWhen: 'no_available_capability_can_deliver_remaining_work' as const,
  };
}

function formatCapabilitySearchResult(
  payload: CapabilitySearchExecutionResult,
  state: Partial<PlannerInvocationState> & { messages?: BaseMessage[] },
  maxSearchRounds: number,
) {
  const input = currentPlannerInput(state);
  const exploration = capabilityExplorationState(state, maxSearchRounds);
  const remainingRounds = Math.max(0, exploration.maxRounds - exploration.roundsUsed);
  const matchedCandidates = [...new Set(
    (payload.ok ? payload.data.matches : []).flatMap((match) => {
      const [capabilityName] = match.path.split('/');
      return capabilityName ? [capabilityName] : [];
    }),
  )];
  const defaultCapabilityName = state.defaultCapability?.capabilityName ?? null;
  const specificCandidates = matchedCandidates;
  const defaultCandidate = input.mode === 'entry' ? defaultCapabilityName : null;
  const availableSpecificCandidates = input.workspace.capabilityNames.filter(
    (capabilityName) => capabilityName !== defaultCapabilityName,
  );
  const discoverableSpecificCandidates = input.mode === 'boundary'
    ? availableSpecificCandidates.filter(
        (capabilityName) => capabilityName !== input.activeDelegation.capability,
      )
    : availableSpecificCandidates;
  const nextSearchCandidates = specificCandidates.length === 0
    && exploration.status === 'open'
    ? discoverableSpecificCandidates.slice(0, MAX_CAPABILITY_DISCOVERY_HINTS)
    : [];
  const limitExceeded = !payload.ok
    && payload.error.code === 'capability_search_round_limit_exceeded';
  const successfulSpecificMiss = payload.ok && specificCandidates.length === 0;
  const planningGuidance = capabilitySearchPlanningGuidance({
    input,
    defaultCandidate,
    matchedCandidates,
    nextSearchCandidates,
    successfulSpecificMiss,
    limitExceeded,
  });
  return JSON.stringify({
    ...payload,
    exploration: {
      status: exploration.status,
      roundsUsed: exploration.roundsUsed,
      attemptedRounds: exploration.attemptedRounds,
      remainingRounds,
      specificCandidates,
      nextSearchCandidates,
      nextSearchCandidatesComplete: nextSearchCandidates.length
        === discoverableSpecificCandidates.length,
      defaultCandidate,
    },
    ...(planningGuidance ? { planningGuidance } : {}),
  });
}

function createPlannerMiddleware(maxSearchRounds: number) {
  return createMiddleware({
    name: 'CapabilityPlanner',
    stateSchema: plannerInvocationStateSchema,
    wrapModelCall: (request, handler) => {
      const input = currentPlannerInput(request.state);
      if (request.state.plannerCommit) {
        return new Command({
          update: { jumpTo: 'end' },
          goto: END,
        });
      }
      const exploration = capabilityExplorationState(request.state, maxSearchRounds);
      return handler({
        ...request,
        systemMessage: new SystemMessage(
          buildCapabilityPlannerAgentSystemPrompt(
            input.mode,
            request.state.defaultCapability ?? null,
            exploration,
          ),
        ),
      });
    },
    wrapToolCall: async (request, handler) => {
      const input = currentPlannerInput(request.state);
      const result = await handler(request);
      if (!ToolMessage.isInstance(result)
        || ![
          CONTINUE_CURRENT_TOOL_NAME,
          SUBMIT_PLAN_TOOL_NAME,
          ADVANCE_PLAN_TOOL_NAME,
          COMPLETE_GOAL_TOOL_NAME,
          REQUEST_USER_INPUT_TOOL_NAME,
          REPORT_UNAVAILABLE_TOOL_NAME,
        ].includes(request.toolCall.name)) {
        return result;
      }
      const rawCommit = readTerminalCommit(result);
      if (!rawCommit) return result;
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

export function createCapabilityPlannerAgent(params: {
  model: BaseChatModel;
  timeoutMs?: number;
  /** Maximum model turns that may execute capability_search discovery. Defaults to 2. */
  maxSearchRounds?: number;
  registryBackend?: CapabilityRegistryBackend;
  maxDocumentReadBytes?: number;
  /** Additional invocation-scoped Planner tools. */
  additionalTools?: StructuredTool[];
}): CapabilityPlannerRunner {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSearchRounds = params.maxSearchRounds
    ?? DEFAULT_CAPABILITY_PLANNER_MAX_SEARCH_ROUNDS;
  assertPositiveInteger(timeoutMs, 'Capability Planner timeoutMs');
  assertPositiveInteger(maxSearchRounds, 'Capability Planner maxSearchRounds');
  if (params.maxDocumentReadBytes !== undefined) {
    assertPositiveInteger(
      params.maxDocumentReadBytes,
      'Capability Planner maxDocumentReadBytes',
    );
  }
  const explorers = new Map<string, CapabilityPlannerFileExplorer>();
  const explorerForInput = (input: CapabilityPlannerInput) => {
    const existing = explorers.get(input.inputId);
    if (existing) return existing;
    const explorer = createCapabilityPlannerFileExplorer({
      workspace: input.workspace,
      registryBackend: params.registryBackend ?? 'filesystem',
      ...(params.maxDocumentReadBytes
        ? { maxDocumentReadBytes: params.maxDocumentReadBytes }
        : {}),
    });
    explorers.set(input.inputId, explorer);
    return explorer;
  };
  const terminalTools = createPlannerTerminalTools();
  const additionalTools = params.additionalTools ?? [];
  const capabilitySearchTool = createCapabilityPlannerSearchTool<PlannerSearchToolState>(
    async (terms, state, signal) => {
      const exploration = capabilityExplorationState(state, maxSearchRounds);
      const payload = exploration.attemptedRounds > exploration.maxRounds
        ? capabilitySearchLimitExceeded(exploration)
        : await explorerForInput(currentPlannerInput(state)).search(terms, signal);
      return formatCapabilitySearchResult(payload, state, maxSearchRounds);
    },
  );
  const middleware = createPlannerMiddleware(maxSearchRounds);
  const agent = createAgent({
    name: 'capabilityPlanner',
    model: params.model,
    tools: [capabilitySearchTool, ...terminalTools, ...additionalTools],
    systemPrompt: '',
    middleware: [middleware],
    checkpointer: false,
  });

  return Object.freeze({
    async invoke(
      input: CapabilityPlannerInput,
      runnableConfig?: RunnableConfig,
    ): Promise<CapabilityPlannerResult> {
      const timeout = mergePlannerSignal(runnableConfig?.signal, timeoutMs);
      const config = buildPlannerRunnableConfig({
        input,
        runnableConfig,
        signal: timeout.signal,
      });
      try {
        timeout.signal.throwIfAborted();
        const cachedCommit = readCachedPlannerCommit(input);
        if (cachedCommit) {
          return parsePlannerCommit(cachedCommit, plannerCommitContext(input));
        }
        const explorer = explorerForInput(input);
        const defaultCapability = await explorer.readDefaultCapability(
          timeout.signal,
        );
        const selectedMessages = input.mode === 'boundary'
          ? selectCapabilityPlannerMessages({
              mode: 'boundary',
              messages: input.messages,
              traceId: input.traceId,
              registryDigest: input.workspace.registryDigest,
              lane: `capability:${input.activeDelegation.capability}`,
              transcriptRunId: input.activeDelegation.transcriptRunId,
              delegationId: input.activeDelegation.delegationId,
            })
          : selectCapabilityPlannerMessages({
              mode: 'entry',
              messages: input.messages,
              traceId: input.traceId,
              registryDigest: input.workspace.registryDigest,
            });
        const result = await agent.invoke({
          messages: [
            ...projectDelegationAnnouncesForModel(selectedMessages),
            new HumanMessage({
              id: `planner:${input.inputId}`,
              content: buildCapabilityPlannerAgentInput(input),
            }),
          ],
          currentInput: input,
          defaultCapability,
        }, config);
        timeout.signal.throwIfAborted();
        if (result.plannerCommit) {
          const commit = parsePlannerCommit(
            result.plannerCommit,
            plannerCommitContext(input),
          );
          return {
            ...commit,
            messageUpdates: buildPlannerMessageUpdates({
              input,
              resultMessages: result.messages,
            }),
          };
        }
        if (explorer.didReachDocumentReadLimit()) {
          throw new CapabilityPlannerAgentError(
            'planning_limit_reached',
            'Capability Planner document read limit was reached before a valid commit.',
          );
        }
        return {
          plannerStatus: 'incomplete',
          reason: 'terminal_commit_missing',
          messageUpdates: buildPlannerMessageUpdates({
            input,
            resultMessages: result.messages,
          }),
        };
      } catch (error) {
        if (timeout.didTimeOut()) {
          throw new CapabilityPlannerAgentError(
            'planning_timeout',
            `Capability Planner exceeded its ${String(timeoutMs)}ms timeout.`,
          );
        }
        throw error;
      } finally {
        timeout.dispose();
        explorers.delete(input.inputId);
      }
    },
  });
}
