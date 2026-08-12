import {
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool, type StructuredTool } from '@langchain/core/tools';
import { Command, END, REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
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

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_PRIVATE_CONTEXT_MAX_CHARS = 96_000;
const DEFAULT_PRIVATE_CONTEXT_KEEP_INPUTS = 6;
const PRIVATE_COMPACTION_ITEM_MAX_CHARS = 2_000;
const PRIVATE_COMPACTION_SUMMARY_MAX_CHARS = 24_000;
const PRIVATE_COMPACTION_MESSAGE_NAME = 'private_planner_compaction';
const MAX_PLAN_TASKS = 24;
const MAX_TASK_TEXT_CHARS = 2_000;
const CONTINUE_CURRENT_TOOL_NAME = 'continue_current';
const SUBMIT_PLAN_TOOL_NAME = 'submit_plan';
const ADVANCE_PLAN_TOOL_NAME = 'advance_plan';
const COMPLETE_GOAL_TOOL_NAME = 'complete_goal';
const REQUEST_USER_INPUT_TOOL_NAME = 'request_user_input';
const REPORT_UNAVAILABLE_TOOL_NAME = 'report_unavailable';

const plannerPrivateStateSchema = z4.object({
  requestedTraceId: z4.string().default(''),
  traceId: z4.string().default(''),
  currentInputId: z4.string().default(''),
  currentInput: z4.custom<CapabilityPlannerInput>(),
  registryDigest: z4.string().default(''),
  plannerCommit: z4.custom<PlannerCommit>().nullable().default(null),
  committedInputId: z4.string().default(''),
  processedInputs: z4.record(
    z4.string(),
    z4.custom<PlannerCommit>(),
  ).default({}),
  compactionCount: z4.number().int().nonnegative().default(0),
});

type PlannerPrivateState = z4.infer<typeof plannerPrivateStateSchema>;

export type CapabilityPlannerAgentErrorCode =
  | 'planning_limit_reached'
  | 'planning_timeout'
  | 'planner_checkpoint_missing'
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
      .describe('A concise execution objective for that Capability. Keep it within 500 characters and do not repeat details already present in the current user goal or conversation.'),
  });
}

function plannerTasksSchema() {
  return z.array(plannerTaskSchema()).min(1).max(MAX_PLAN_TASKS)
    .describe('Ordered execution boundaries. Keep continuous work by one Capability in one task; preserve a separate boundary when later work depends on the accepted result of the current task.');
}

function createPlannerTerminalTools(): StructuredTool[] {
  const continueCurrent = tool(
    async ({ tasks }: { tasks: Array<{ capability: string; task: string }> }) => {
      return JSON.stringify({ action: 'continue_current', tasks });
    },
    {
      name: CONTINUE_CURRENT_TOOL_NAME,
      description: 'Boundary-only terminal action. The current task is incomplete. Continue the same active delegation; the first task must use the Current Capability shown in the Planner input. Optional future tasks may follow.',
      schema: z.object({ tasks: plannerTasksSchema() }),
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
  const requestUserInput = tool(
    async () => JSON.stringify({ action: 'user_input_required', tasks: [] }),
    {
      name: REQUEST_USER_INPUT_TOOL_NAME,
      description: 'Terminal Planner action. Further progress must wait for user input. Do not provide a question or explanation.',
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

function readPrivateMessageText(message: BaseMessage) {
  if (typeof message.content === 'string') return message.content;
  try {
    return JSON.stringify(message.content);
  } catch {
    return String(message.content);
  }
}

function clipPrivateText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[private Planner context truncated]`;
}

function buildPrivateCompactionSummary(messages: readonly BaseMessage[]) {
  const facts: string[] = [];
  for (const message of messages) {
    const text = readPrivateMessageText(message).trim();
    if (!text) continue;
    if (message._getType() === 'system'
      && message.name === PRIVATE_COMPACTION_MESSAGE_NAME) {
      facts.push(text);
      continue;
    }
    if (message._getType() === 'human'
      && message.id?.startsWith('planner:')) {
      facts.push(`Planner input:\n${clipPrivateText(text, PRIVATE_COMPACTION_ITEM_MAX_CHARS)}`);
      continue;
    }
    if (ToolMessage.isInstance(message)) {
      const label = [
        CONTINUE_CURRENT_TOOL_NAME,
        SUBMIT_PLAN_TOOL_NAME,
        ADVANCE_PLAN_TOOL_NAME,
        COMPLETE_GOAL_TOOL_NAME,
        REQUEST_USER_INPUT_TOOL_NAME,
        REPORT_UNAVAILABLE_TOOL_NAME,
      ].includes(message.name ?? '')
        ? 'Planner commit'
        : `Private tool observation (${message.name ?? 'unknown'})`;
      facts.push(`${label}:\n${clipPrivateText(text, PRIVATE_COMPACTION_ITEM_MAX_CHARS)}`);
    }
  }
  return clipPrivateText([
    '<private_planner_compaction>',
    'Private task history retained for later planning. This content must never leave the Planner checkpoint.',
    ...facts,
    '</private_planner_compaction>',
  ].join('\n\n'), PRIVATE_COMPACTION_SUMMARY_MAX_CHARS);
}

function compactPrivatePlannerMessages(params: {
  messages: readonly BaseMessage[];
  maxChars: number;
  keepInputs: number;
}) {
  const totalChars = params.messages.reduce(
    (sum, message) => sum + readPrivateMessageText(message).length,
    0,
  );
  if (totalChars <= params.maxChars) return null;
  const inputIndexes = params.messages.flatMap((message, index) =>
    message._getType() === 'human' && message.id?.startsWith('planner:')
      ? [index]
      : [],
  );
  if (inputIndexes.length <= params.keepInputs) return null;
  const keepFrom = inputIndexes.at(-params.keepInputs);
  if (keepFrom === undefined || keepFrom <= 0) return null;
  const summary = new SystemMessage(
    buildPrivateCompactionSummary(params.messages.slice(0, keepFrom)),
  );
  summary.name = PRIVATE_COMPACTION_MESSAGE_NAME;
  return [
    new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
    summary,
    ...params.messages.slice(keepFrom),
  ];
}

function buildPlannerRunnableConfig(params: {
  input: CapabilityPlannerInput;
  runnableConfig?: RunnableConfig;
  signal: AbortSignal;
}): RunnableConfig {
  const {
    checkpoint_id: _parentCheckpointId,
    checkpoint_map: _parentCheckpointMap,
    checkpoint_ns: _parentCheckpointNamespace,
    ...configurable
  } = params.runnableConfig?.configurable ?? {};
  return {
    ...params.runnableConfig,
    configurable: {
      ...configurable,
      // The Planner is invoked manually from the root node, so LangGraph does
      // not assign it a stable subgraph task namespace. Derive that namespace
      // from the task identity itself; no independent Planner session id is
      // introduced, and a new root run can reopen the latest trace checkpoint.
      checkpoint_ns: `privateCapabilityPlanner_${params.input.traceId}`,
    },
    signal: params.signal,
    runName: 'framework.private_capability_planner',
    tags: [
      ...(params.runnableConfig?.tags ?? []),
      'framework.private_capability_planner',
    ],
    metadata: {
      ...(params.runnableConfig?.metadata ?? {}),
      frameworkComponent: 'private_capability_planner',
      traceId: params.input.traceId,
      runId: params.input.runId,
      plannerInputId: params.input.inputId,
      registryDigest: params.input.workspace.registryDigest,
      plannerMode: params.input.mode,
    },
  };
}

function currentPlannerInput(state: Partial<PlannerPrivateState>) {
  if (!state.currentInput) {
    throw new Error('Private Planner state has no current input.');
  }
  return state.currentInput;
}

function createPrivatePlannerMiddleware(params: {
  privateContextMaxChars: number;
  privateContextKeepInputs: number;
}) {
  return createMiddleware({
    name: 'PrivateCapabilityPlanner',
    stateSchema: plannerPrivateStateSchema,
    beforeAgent: {
      canJumpTo: ['end'],
      hook: (state) => {
        const input = currentPlannerInput(state);
        const traceChanged = state.traceId !== state.requestedTraceId;
        const registryChanged = Boolean(
          state.registryDigest
          && state.registryDigest !== input.workspace.registryDigest,
        );
        const cachedCommit = traceChanged || registryChanged
          ? null
          : state.committedInputId === state.currentInputId
            ? state.plannerCommit
            : state.processedInputs?.[state.currentInputId] ?? null;
        const message = state.messages.find((item) =>
          item.id === `planner:${state.currentInputId}`,
        );
        const resetMessages: BaseMessage[] = traceChanged || registryChanged
          ? [
              new RemoveMessage({ id: REMOVE_ALL_MESSAGES }),
              ...(message ? [message] : []),
            ]
          : [];
        const compactedMessages = resetMessages.length === 0
          ? compactPrivatePlannerMessages({
              messages: state.messages,
              maxChars: params.privateContextMaxChars,
              keepInputs: params.privateContextKeepInputs,
            })
          : null;
        return {
          ...(resetMessages.length > 0
            ? { messages: resetMessages }
            : compactedMessages
              ? { messages: compactedMessages }
              : {}),
          traceId: state.requestedTraceId,
          registryDigest: input.workspace.registryDigest,
          plannerCommit: cachedCommit,
          committedInputId: traceChanged || registryChanged ? '' : state.committedInputId,
          processedInputs: traceChanged || registryChanged ? {} : state.processedInputs,
          compactionCount: traceChanged || registryChanged
            ? 0
            : state.compactionCount + (compactedMessages ? 1 : 0),
          ...(cachedCommit ? { jumpTo: 'end' as const } : {}),
        };
      },
    },
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
          committedInputId: input.inputId,
          processedInputs: {
            ...(request.state.processedInputs ?? {}),
            [input.inputId]: commit,
          },
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
  /** Private checkpoint transcript budget before deterministic compaction. */
  privateContextMaxChars?: number;
  /** Recent Planner inputs retained verbatim after private compaction. */
  privateContextKeepInputs?: number;
  /** Private Planner-only tools, primarily for host middleware and HITL. */
  additionalPrivateTools?: StructuredTool[];
}): CapabilityPlannerRunner {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertPositiveInteger(timeoutMs, 'Capability Planner timeoutMs');
  if (params.maxDocumentReadBytes !== undefined) {
    assertPositiveInteger(
      params.maxDocumentReadBytes,
      'Capability Planner maxDocumentReadBytes',
    );
  }
  const privateContextMaxChars = params.privateContextMaxChars
    ?? DEFAULT_PRIVATE_CONTEXT_MAX_CHARS;
  const privateContextKeepInputs = params.privateContextKeepInputs
    ?? DEFAULT_PRIVATE_CONTEXT_KEEP_INPUTS;
  assertPositiveInteger(privateContextMaxChars, 'Capability Planner privateContextMaxChars');
  assertPositiveInteger(privateContextKeepInputs, 'Capability Planner privateContextKeepInputs');

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
  const additionalPrivateTools = params.additionalPrivateTools ?? [];
  const capabilitySearchTool = createCapabilityPlannerSearchTool<PlannerPrivateState>(
    (terms, runtime) => explorerForInput(
      currentPlannerInput(runtime.state),
    ).search(terms, runtime.signal),
  );
  const capabilitySearchLimitMiddleware = toolCallLimitMiddleware({
    toolName: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
    runLimit: CAPABILITY_PLANNER_MAX_CAPABILITY_SEARCH_CALLS,
    exitBehavior: 'continue',
  });
  const middleware = createPrivatePlannerMiddleware({
    privateContextMaxChars,
    privateContextKeepInputs,
  });
  const buildAgent = (checkpointer: boolean) => createAgent({
    name: 'privateCapabilityPlanner',
    model: params.model,
    tools: [capabilitySearchTool, ...terminalTools, ...additionalPrivateTools],
    systemPrompt: '',
    middleware: [capabilitySearchLimitMiddleware, middleware],
    checkpointer,
  });
  // These are the two standard LangGraph subgraph persistence modes used by
  // this runner. Production uses per-thread persistence (`true`) inherited
  // from the parent; direct tests/evals use the precompiled stateless adapter
  // (`false`). Neither graph is rebuilt per Planner invocation.
  const persistentAgent = buildAgent(true);
  const statelessDirectAgent = buildAgent(false);

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
        const hasParentCheckpointer = Boolean(
          runnableConfig?.configurable?.__pregel_checkpointer,
        );
        const selectedAgent = hasParentCheckpointer
          ? persistentAgent
          : statelessDirectAgent;
        if (hasParentCheckpointer) {
          const snapshot = await persistentAgent.graph.getState(config);
          const saved = snapshot.values as Partial<PlannerPrivateState>;
          if (input.mode === 'boundary' && saved.traceId !== input.traceId) {
            throw new CapabilityPlannerAgentError(
              'planner_checkpoint_missing',
              `Capability Planner checkpoint is missing for trace ${input.traceId}.`,
            );
          }
          if (saved.traceId === input.traceId
            && saved.registryDigest
            && saved.registryDigest !== input.workspace.registryDigest) {
            await persistentAgent.graph.updateState(config, {
              messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES })],
              requestedTraceId: input.traceId,
              traceId: input.traceId,
              currentInputId: input.inputId,
              currentInput: input,
              registryDigest: input.workspace.registryDigest,
              plannerCommit: null,
              committedInputId: '',
              processedInputs: {},
              compactionCount: 0,
            });
          }
          const cachedCommit = saved.traceId === input.traceId
            && saved.registryDigest === input.workspace.registryDigest
            ? saved.processedInputs?.[input.inputId]
              ?? (saved.committedInputId === input.inputId
                ? saved.plannerCommit
                : null)
            : null;
          if (cachedCommit) {
            return parsePlannerCommit(cachedCommit, {
              mode: input.mode,
              activeDelegation: input.activeDelegation,
              allowedCapabilityNames: input.workspace.capabilityNames,
            });
          }
        }
        const explorer = explorerForInput(input);
        const defaultCapability = await explorer.readDefaultCapability(
          timeout.signal,
        );
        const result = await selectedAgent.invoke({
          messages: [new HumanMessage({
            id: `planner:${input.inputId}`,
            content: buildCapabilityPlannerAgentInput(
              input,
              defaultCapability,
            ),
          })],
          requestedTraceId: input.traceId,
          currentInputId: input.inputId,
          currentInput: input,
          registryDigest: input.workspace.registryDigest,
        }, config);
        timeout.signal.throwIfAborted();
        if (result.plannerCommit) {
          return parsePlannerCommit(result.plannerCommit, {
            mode: input.mode,
            activeDelegation: input.activeDelegation,
            allowedCapabilityNames: input.workspace.capabilityNames,
          });
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
