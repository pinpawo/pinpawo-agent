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
  toolCallLimitMiddleware,
} from 'langchain';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import {
  CAPABILITY_PLANNER_MAX_CAPABILITY_SEARCH_CALLS,
  CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
  createCapabilityPlannerFileExplorer,
  createCapabilityPlannerSearchTool,
  type CapabilityPlannerFileExplorer,
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

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LANE_CONTEXT_MAX_CHARS = 96_000;
const DEFAULT_LANE_CONTEXT_KEEP_INPUTS = 6;
const LANE_COMPACTION_ITEM_MAX_CHARS = 2_000;
const LANE_COMPACTION_SUMMARY_MAX_CHARS = 24_000;
const LANE_COMPACTION_MESSAGE_NAME = 'planner_lane_compaction';
const MAX_PLAN_TASKS = 24;
const MAX_TASK_TEXT_CHARS = 2_000;
const CONTINUE_CURRENT_TOOL_NAME = 'continue_current';
const SUBMIT_PLAN_TOOL_NAME = 'submit_plan';
const ADVANCE_PLAN_TOOL_NAME = 'advance_plan';
const ANSWER_DIRECTLY_TOOL_NAME = 'answer_directly';
const COMPLETE_GOAL_TOOL_NAME = 'complete_goal';
const REQUEST_USER_INPUT_TOOL_NAME = 'request_user_input';
const REPORT_UNAVAILABLE_TOOL_NAME = 'report_unavailable';

const plannerInvocationStateSchema = z4.object({
  currentInput: z4.custom<CapabilityPlannerInput>(),
  plannerCommit: z4.custom<PlannerCommit>().nullable().default(null),
  terminalRepairInputId: z4.string().default(''),
});

type PlannerInvocationState = z4.infer<typeof plannerInvocationStateSchema>;

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

function plannerTaskSchema() {
  return z.object({
    capability: z.string().trim().min(1).max(200)
      .describe('Capability that executes this task.'),
    task: z.string().trim().min(1).max(MAX_TASK_TEXT_CHARS)
      .describe('A concise execution objective for that Capability. Keep it within 500 characters and do not repeat details already present in the current user request or conversation.'),
  });
}

function plannerTasksSchema() {
  return z.array(plannerTaskSchema()).min(1).max(MAX_PLAN_TASKS)
    .describe('Ordered execution boundaries. Keep continuous work by one Capability in one task; preserve a separate boundary when later work depends on the accepted result of the current task.');
}

function createPlannerTerminalTools(): StructuredTool[] {
  const continueCurrent = tool(
    async () => JSON.stringify({ action: 'continue_current', tasks: [] }),
    {
      name: CONTINUE_CURRENT_TOOL_NAME,
      description: 'Boundary-only terminal action. The current task remains executable but incomplete, so continue the same delegation without replacing its task or remaining plan.',
      schema: z.object({}).strict(),
    },
  );
  const submitPlan = tool(
    async ({ tasks }: { tasks: Array<{ capability: string; task: string }> }) => {
      return JSON.stringify({ action: 'execute_plan', tasks });
    },
    {
      name: SUBMIT_PLAN_TOOL_NAME,
      description: 'Entry-only terminal action. Submit the initial shortest executable task sequence.',
      schema: z.object({ tasks: plannerTasksSchema() }),
    },
  );
  const advancePlan = tool(
    async ({ tasks }: { tasks: Array<{ capability: string; task: string }> }) => {
      return JSON.stringify({ action: 'advance_plan', tasks });
    },
    {
      name: ADVANCE_PLAN_TOOL_NAME,
      description: 'Boundary-only terminal action. Accept the completed current task and submit the shortest updated sequence of remaining work. The next task may use a different Capability.',
      schema: z.object({ tasks: plannerTasksSchema() }),
    },
  );
  const completeGoal = tool(
    async () => JSON.stringify({ action: 'goal_done', tasks: [] }),
    {
      name: COMPLETE_GOAL_TOOL_NAME,
      description: 'Terminal Planner action. The accepted execution evidence completes the user goal.',
      schema: z.object({}).strict(),
    },
  );
  const answerDirectly = tool(
    async () => JSON.stringify({ action: 'answer_directly', tasks: [] }),
    {
      name: ANSWER_DIRECTLY_TOOL_NAME,
      description: 'Terminal Planner action for entry only. The current goal can be answered from the canonical main conversation without Capability execution. Do not provide answer text.',
      schema: z.object({}).strict(),
    },
  );
  const requestUserInput = tool(
    async () => JSON.stringify({ action: 'user_input_required', tasks: [] }),
    {
      name: REQUEST_USER_INPUT_TOOL_NAME,
      description: 'Terminal Planner action. Further progress requires a user choice or missing information. Answer will use the current delegation result to ask the user.',
      schema: z.object({}).strict(),
    },
  );
  const reportUnavailable = tool(
    async () => JSON.stringify({ action: 'unavailable', tasks: [] }),
    {
      name: REPORT_UNAVAILABLE_TOOL_NAME,
      description: 'Terminal Planner action. No available Capability can form an executable plan. Do not provide a reason or explanation.',
      schema: z.object({}).strict(),
    },
  );
  return [
    continueCurrent,
    submitPlan,
    advancePlan,
    answerDirectly,
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

function readPlannerMessageText(message: BaseMessage) {
  if (typeof message.content === 'string') return message.content;
  try {
    return JSON.stringify(message.content);
  } catch {
    return String(message.content);
  }
}

function clipPlannerText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[Planner lane context truncated]`;
}

function buildPlannerCompactionSummary(messages: readonly BaseMessage[]) {
  const facts: string[] = [];
  for (const message of messages) {
    const text = readPlannerMessageText(message).trim();
    if (!text) continue;
    if (message._getType() === 'system'
      && message.name === LANE_COMPACTION_MESSAGE_NAME) {
      facts.push(text);
      continue;
    }
    if (message._getType() === 'human'
      && message.id?.startsWith('planner:')) {
      facts.push(`Planner input:\n${clipPlannerText(text, LANE_COMPACTION_ITEM_MAX_CHARS)}`);
      continue;
    }
    if (ToolMessage.isInstance(message)) {
      const label = [
        CONTINUE_CURRENT_TOOL_NAME,
        SUBMIT_PLAN_TOOL_NAME,
        ADVANCE_PLAN_TOOL_NAME,
        ANSWER_DIRECTLY_TOOL_NAME,
        COMPLETE_GOAL_TOOL_NAME,
        REQUEST_USER_INPUT_TOOL_NAME,
        REPORT_UNAVAILABLE_TOOL_NAME,
      ].includes(message.name ?? '')
        ? 'Planner commit'
        : `Planner tool observation (${message.name ?? 'unknown'})`;
      facts.push(`${label}:\n${clipPlannerText(text, LANE_COMPACTION_ITEM_MAX_CHARS)}`);
    }
  }
  return clipPlannerText([
    '<planner_lane_compaction>',
    'Earlier Planner-lane history retained for later planning.',
    ...facts,
    '</planner_lane_compaction>',
  ].join('\n\n'), LANE_COMPACTION_SUMMARY_MAX_CHARS);
}

function compactPlannerLaneMessages(params: {
  messages: readonly BaseMessage[];
  maxChars: number;
  keepInputs: number;
}) {
  const totalChars = params.messages.reduce(
    (sum, message) => sum + readPlannerMessageText(message).length,
    0,
  );
  if (totalChars <= params.maxChars) {
    return { messages: [...params.messages], updates: [] as BaseMessage[] };
  }
  const inputIndexes = params.messages.flatMap((message, index) =>
    message._getType() === 'human' && message.id?.startsWith('planner:')
      ? [index]
      : [],
  );
  if (inputIndexes.length <= params.keepInputs) {
    return { messages: [...params.messages], updates: [] as BaseMessage[] };
  }
  const keepFrom = inputIndexes.at(-params.keepInputs);
  if (keepFrom === undefined || keepFrom <= 0) {
    return { messages: [...params.messages], updates: [] as BaseMessage[] };
  }
  const summary = new SystemMessage(
    buildPlannerCompactionSummary(params.messages.slice(0, keepFrom)),
  );
  summary.name = LANE_COMPACTION_MESSAGE_NAME;
  const removed = params.messages.slice(0, keepFrom).flatMap((message) =>
    message.id ? [new RemoveMessage({ id: message.id }) as BaseMessage] : [],
  );
  return {
    messages: [summary, ...params.messages.slice(keepFrom)],
    updates: [...removed, summary],
  };
}

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

function buildPlannerMessageUpdates(params: {
  input: CapabilityPlannerInput;
  resultMessages: readonly BaseMessage[];
  compactionUpdates: readonly BaseMessage[];
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
  const compactionRemovals = params.compactionUpdates.filter(RemoveMessage.isInstance);
  return [
    ...stalePlannerRemovals,
    ...compactionRemovals,
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

function terminalRepairMessage(input: CapabilityPlannerInput) {
  const actions = input.mode === 'entry'
    ? 'submit_plan, request_user_input, or report_unavailable'
    : 'continue_current, advance_plan, complete_goal, request_user_input, or report_unavailable';
  return `Your previous response did not finish this Planner turn. Invoke exactly one valid terminal tool now: ${actions}. Do not respond with ordinary text.`;
}

function createPlannerMiddleware() {
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
      return handler({
        ...request,
        systemMessage: new SystemMessage(
          buildCapabilityPlannerAgentSystemPrompt(input.mode),
        ),
      });
    },
    afterAgent: {
      hook: (state) => {
        const input = currentPlannerInput(state);
        const latestMessage = state.messages.at(-1);
        if (!AIMessage.isInstance(latestMessage)
          || latestMessage.tool_calls?.length
          || state.plannerCommit
          || state.terminalRepairInputId === input.inputId) {
          return undefined;
        }
        return {
          messages: [new HumanMessage({
            id: `planner-repair:${input.inputId}`,
            content: terminalRepairMessage(input),
          })],
          terminalRepairInputId: input.inputId,
          jumpTo: 'model' as const,
        };
      },
      canJumpTo: ['model'],
    },
    wrapToolCall: async (request, handler) => {
      const input = currentPlannerInput(request.state);
      const result = await handler(request);
      if (!ToolMessage.isInstance(result)
        || ![
          CONTINUE_CURRENT_TOOL_NAME,
          SUBMIT_PLAN_TOOL_NAME,
          ADVANCE_PLAN_TOOL_NAME,
          ANSWER_DIRECTLY_TOOL_NAME,
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
        commit = parsePlannerCommit(rawCommit, {
          mode: input.mode,
          activeDelegation: input.activeDelegation,
          allowedCapabilityNames: input.workspace.capabilityNames,
        });
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
  registryBackend?: CapabilityRegistryBackend;
  maxDocumentReadBytes?: number;
  /** Planner-lane transcript budget before deterministic compaction. */
  laneContextMaxChars?: number;
  /** Recent Planner inputs retained verbatim after lane compaction. */
  laneContextKeepInputs?: number;
  /** Additional invocation-scoped Planner tools. */
  additionalTools?: StructuredTool[];
}): CapabilityPlannerRunner {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertPositiveInteger(timeoutMs, 'Capability Planner timeoutMs');
  if (params.maxDocumentReadBytes !== undefined) {
    assertPositiveInteger(
      params.maxDocumentReadBytes,
      'Capability Planner maxDocumentReadBytes',
    );
  }
  const laneContextMaxChars = params.laneContextMaxChars
    ?? DEFAULT_LANE_CONTEXT_MAX_CHARS;
  const laneContextKeepInputs = params.laneContextKeepInputs
    ?? DEFAULT_LANE_CONTEXT_KEEP_INPUTS;
  assertPositiveInteger(laneContextMaxChars, 'Capability Planner laneContextMaxChars');
  assertPositiveInteger(laneContextKeepInputs, 'Capability Planner laneContextKeepInputs');

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
  const capabilitySearchTool = createCapabilityPlannerSearchTool<PlannerInvocationState>(
    (terms, runtime) => explorerForInput(
      currentPlannerInput(runtime.state),
    ).search(terms, runtime.signal),
  );
  const capabilitySearchLimitMiddleware = toolCallLimitMiddleware({
    toolName: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
    runLimit: CAPABILITY_PLANNER_MAX_CAPABILITY_SEARCH_CALLS,
    exitBehavior: 'continue',
  });
  const middleware = createPlannerMiddleware();
  const agent = createAgent({
    name: 'capabilityPlanner',
    model: params.model,
    tools: [capabilitySearchTool, ...terminalTools, ...additionalTools],
    systemPrompt: '',
    middleware: [capabilitySearchLimitMiddleware, middleware],
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
          return parsePlannerCommit(cachedCommit, {
            mode: input.mode,
            activeDelegation: input.activeDelegation,
            allowedCapabilityNames: input.workspace.capabilityNames,
          });
        }
        const explorer = explorerForInput(input);
        const defaultCapability = await explorer.readDefaultCapability(
          timeout.signal,
        );
        const selectedMessages = input.mode === 'boundary' && input.activeDelegation
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
        const plannerLane = selectedMessages.filter((message) =>
          isCapabilityPlannerMessage(
            message,
            input.traceId,
            input.workspace.registryDigest,
          ),
        );
        const compacted = compactPlannerLaneMessages({
          messages: plannerLane,
          maxChars: laneContextMaxChars,
          keepInputs: laneContextKeepInputs,
        });
        const contextMessages = selectedMessages.filter((message) =>
          !isCapabilityPlannerMessage(message, input.traceId),
        );
        const result = await agent.invoke({
          messages: [
            ...compacted.messages,
            ...contextMessages,
            new HumanMessage({
              id: `planner:${input.inputId}`,
              content: buildCapabilityPlannerAgentInput(
                input,
                defaultCapability,
              ),
            }),
          ],
          currentInput: input,
        }, config);
        timeout.signal.throwIfAborted();
        if (result.plannerCommit) {
          const commit = parsePlannerCommit(result.plannerCommit, {
            mode: input.mode,
            activeDelegation: input.activeDelegation,
            allowedCapabilityNames: input.workspace.capabilityNames,
          });
          return {
            ...commit,
            messageUpdates: buildPlannerMessageUpdates({
              input,
              resultMessages: result.messages,
              compactionUpdates: compacted.updates,
            }),
          };
        }
        if (explorer.didReachDocumentReadLimit()) {
          throw new CapabilityPlannerAgentError(
            'planning_limit_reached',
            'Capability Planner document read limit was reached before a valid commit.',
          );
        }
        throw new CapabilityPlannerAgentError(
          'submission_required',
          'Capability Planner must finish with a structured commit tool.',
        );
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
