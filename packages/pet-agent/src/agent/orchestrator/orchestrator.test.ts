import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages/tool';
import { tool, type StructuredTool, type ToolRuntime } from '@langchain/core/tools';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { Command, MemorySaver, messagesStateReducer } from '@langchain/langgraph';
import { createMiddleware, FakeToolCallingModel } from 'langchain';
import { z } from 'zod';
import {
  defineInstructionDocument,
  type AgentCapability,
} from '../../types/capability';
import type { AgentActor, AgentModels } from '../../types/agent';
import type {
  AgentToolkit,
  ModelInputModality,
  ToolDefinition,
  ToolReviewPolicy,
  ToolkitRuntimeResolveContext,
} from '../../types/toolkit';
import { createSubagent } from '../../subagent/createSubagent';
import { runAgent } from '../runAgent';
import {
  buildOrchestratorRunInput,
  createOrchestratorGraph as createRuntimeOrchestratorGraph,
} from '../createAgentRuntime';
import { compileAgentRegistry } from './registry';
import { ToolkitRuntimeManager } from './toolkitRuntime';
import {
  collectToolkitOperations,
  resolveToolkitExecution,
} from './subagentDispatch';
import { buildReviewSpec } from './review/reviewSpec';
import {
  exactAuthorization,
  type ToolAuthorizationRecord,
} from './review/reviewAuthorizations';
import {
  AuthorizationPolicies,
  ReviewPolicies,
} from './review/reviewPolicies';
import {
  getAgentMessageDelegationId,
  getAgentMessageLane,
  getAgentMessageRunId,
  getAgentMessageMetadata,
  mainConversationMessages,
  queryAgentMessages,
  readAgentMessageCreatedAt,
  setAgentMessageDelegationScope,
  setAgentMessageMetadata,
  toolProtocolSafeMessages,
} from '../messages';
import {
  DelegationAnnounceMessage,
  buildSubagentHandoff,
  getDelegationAnnounce,
  getMessageHandoffSource,
  readLatestAnnounce,
  selectDelegationAnnounceMessage,
  reconcileDelegationPrivateMessages,
  isDelegationBriefingMessage,
  materializeDelegation,
} from './delegation';
import { RemoveMessage } from '@langchain/core/messages';
import {
  appendRunDelegationSummary,
  resumeRunDelegationSummary,
  updateRunDelegationSummaryResult,
} from './delegations';
import {
  createContextCompactionMessage,
  isContextCompactionMessage,
} from './contextCompaction';
import { findLatestHandoffCopyForDelegation } from './artifacts/handoff';

function isTypedDelegationAnnounce(message: BaseMessage) {
  return getDelegationAnnounce(message) !== null;
}

function createPrivateAnnounce(params: {
  id?: string;
  lane: `capability:${string}`;
  runId: string;
  delegationId: string;
  task?: string | null;
  result: string;
  completionReason?: 'natural' | 'limit_reached' | 'interrupted' | 'error';
}) {
  const announceMessageId = params.id ?? `announce:${params.runId}:${params.delegationId}`;
  return setAgentMessageDelegationScope(new DelegationAnnounceMessage({
    ...(params.id ? { id: params.id } : {}),
    sourceLane: params.lane,
    runId: params.runId,
    delegationId: params.delegationId,
    announceMessageId,
    task: params.task ?? null,
    completionReason: params.completionReason ?? 'natural',
    result: params.result,
    createdAt: '2026-08-31T00:00:00.000Z',
  }), {
    lane: params.lane,
    runId: params.runId,
    delegationId: params.delegationId,
  });
}

function selectCapabilityHistory(
  messages: readonly BaseMessage[],
  lane: `capability:${string}`,
  runId: string,
  delegationId: string,
) {
  return toolProtocolSafeMessages(
    queryAgentMessages(messages)
      .main()
      .delegation({ lane, runId, delegationId })
      .select()
      .messages,
  );
}
import type { RunDelegationSummary, TaskActiveDelegation } from './types';
import type { SubagentRuntimeContext } from '../../types/subagent';
import {
  ORCHESTRATOR_STATE_CHANNEL_NAMES,
  type OrchestratorStateType,
} from './state';
import { applyActiveDelegationTransition } from './runtime/activeDelegationTransition';
import { afterContextPrep } from './runtime/routes/afterContextPrep';
import {
  type CapabilityPlannerInput,
  type CapabilityPlannerResult,
  type CapabilityPlannerRunner,
} from './capabilityPlanner/runner';
import { readMessageText } from './utils';
import { PLAN_REQUEST_TOOL_NAME } from './runtime/nodes/entryAnswer';

function plannerMessageContextText(input: CapabilityPlannerInput | null | undefined) {
  return input?.messages.map(readMessageText).join('\n') ?? '';
}

function capability(
  name: string,
  description: string,
  uses: readonly string[] = [],
): AgentCapability {
  return {
    name,
    description,
    uses,
    instructions: defineInstructionDocument({
      content: `Execute the ${name} capability.`,
    }),
  };
}

function readLatestHumanText(messages: BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?._getType() !== 'human') continue;
    const text = typeof message.content === 'string' ? message.content : message.text;
    if (text.trim()) return text;
  }
  return 'Execute the requested task.';
}

function createOrchestratorGraph(
  config: Parameters<typeof createRuntimeOrchestratorGraph>[0],
): ReturnType<typeof createRuntimeOrchestratorGraph> {
  const resultAnswerModel = config.models.answer ?? config.models.act;
  const entryPlanningAnswerModel = new Proxy(resultAnswerModel, {
    get(target, property) {
      if (property === 'bindTools') {
        return () => ({
          // Stand in for Entry Answer's goal resolution: echo the latest human
          // message, which is what a real model produces when the current
          // request already states the goal on its own.
          invoke: async (messages: BaseMessage[]) => new AIMessage({
            content: '',
            tool_calls: [{
              id: 'test-plan-request',
              name: PLAN_REQUEST_TOOL_NAME,
              args: { goal: readLatestHumanText(messages) },
            }],
          }),
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const graph = createRuntimeOrchestratorGraph({
    ...config,
    models: {
      ...config.models,
      answer: entryPlanningAnswerModel,
    },
    capabilityPlannerRunner:
      config.capabilityPlannerRunner ?? createQueuedPlannerRunner(config.models.act),
  });
  const withRegistry = (options: {
    configurable?: Record<string, unknown>;
  } = {}) => {
    const configurable = options.configurable ?? {};
    return {
      ...options,
      configurable: {
        ...configurable,
        registry: compileAgentRegistry({
          toolkits: (configurable.toolkits ?? []) as AgentToolkit[],
          capabilities: (configurable.capabilities ?? []) as AgentCapability[],
        }),
      },
    };
  };
  const withCurrentPlannerCheckpoint = (input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const state = input as Record<string, unknown>;
    if (!state.taskActiveDelegation
      || state.runPlannerSession) {
      return input;
    }
    // Direct boundary fixtures represent checkpoints created by the current
    // schema. A deliberately null field remains available to test the breaking
    // old-checkpoint boundary.
    return {
      ...state,
      taskPlannerContinuation: state.taskPlannerContinuation ?? {
        traceId: (state.taskActiveDelegation as TaskActiveDelegation).traceId,
        userRequest: (state.taskActiveDelegation as TaskActiveDelegation).userRequest,
        activeDelegationId: (state.taskActiveDelegation as TaskActiveDelegation).id,
        remainingPlan: [],
      },
      runPlannerSession: {
        runId: state.runId,
        revision: 0,
        plan: state.taskPlannerContinuation
          && typeof state.taskPlannerContinuation === 'object'
          && !Array.isArray(state.taskPlannerContinuation)
          && Array.isArray((state.taskPlannerContinuation as Record<string, unknown>).remainingPlan)
          ? (state.taskPlannerContinuation as Record<string, unknown>).remainingPlan
          : [],
        capabilityDisclosure: {
          registryDigest: 'test-fixture-registry-generation',
          disclosedCapabilityNames: [],
          emptySearchRounds: 0,
          maxEmptySearchRounds: 2,
          status: 'open',
        },
        lastCommit: null,
      },
    };
  };
  return new Proxy(graph, {
    get(target, property, receiver) {
      if (property === 'invoke' || property === 'streamEvents') {
        return (input: unknown, options: {
          configurable?: Record<string, unknown>;
        } = {}) => target[property](
          withCurrentPlannerCheckpoint(input) as never,
          withRegistry(options) as never,
        );
      }
      if (property === 'updateState') {
        return (options: { configurable?: Record<string, unknown> }, values: unknown) =>
          target.updateState(
            withRegistry(options) as never,
            withCurrentPlannerCheckpoint(values) as never,
          );
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function createQueuedPlannerRunner(
  model: AgentModels['act'],
): CapabilityPlannerRunner {
  const nextStructuredValue = async () => {
    const structured = model.withStructuredOutput(
      z.record(z.unknown()),
      { name: 'scripted_capability_planner' },
    );
    return await structured.invoke([]) as Record<string, unknown>;
  };

  return {
    async invoke(input: CapabilityPlannerInput): Promise<CapabilityPlannerResult> {
      const planning = await nextStructuredValue();
      if (planning.action === 'unavailable') {
        return { action: 'unavailable', tasks: [] };
      }
      if (input.mode === 'boundary' && typeof planning.outcome === 'string') {
        if (planning.outcome === 'goal_done') {
          return { action: 'goal_done', tasks: [] };
        }
        if (planning.outcome === 'user_input_required') {
          return {
            action: 'user_input_required',
            tasks: [],
            userInputRequest: {
              question: typeof planning.question === 'string'
                ? planning.question
                : '请提供继续当前任务所需的选择或信息。',
            },
          };
        }
        if (planning.outcome === 'continue') {
          const active = input.activeDelegation;
          if (!active) throw new Error('scripted continue requires active delegation');
          return {
            action: 'continue_current',
            tasks: [],
          };
        }
        if (planning.outcome !== 'task_done') {
          throw new Error(`unsupported scripted planner outcome ${planning.outcome}`);
        }
        if (input.announceAttempts.length === 0) {
          return { action: 'unavailable', tasks: [] };
        }
        return this.invoke(input);
      }
      const [nextTask, ...remainingTasks] = Array.isArray(planning.tasks)
        ? planning.tasks as Array<{ capability?: unknown; task?: unknown }>
        : [];
      if (!nextTask) {
        throw new Error('scripted Capability Planner requires at least one task');
      }
      const capabilityName = String(
        (await nextStructuredValue()).capabilityName ?? '',
      );
      return {
        action: input.mode === 'boundary' ? 'advance_plan' : 'execute_plan',
        tasks: [
          {
            capability: capabilityName,
            task: String(nextTask.task ?? ''),
          },
          ...remainingTasks.map((task) => ({
            capability: String(task.capability ?? ''),
            task: String(task.task ?? ''),
          })),
        ],
      };
    },
  };
}

function mockTool(name: string) {
  return tool(async () => `${name} ok`, {
    name,
    description: `${name} tool`,
    schema: z.object({}),
  });
}

function toolDefinition(
  toolItem: StructuredTool,
  options: Omit<ToolDefinition, 'tool'> = {},
): ToolDefinition {
  return {
    tool: toolItem,
    ...options,
  };
}

function toolDefinitions(...tools: StructuredTool[]): ToolDefinition[] {
  return tools.map((toolItem) => toolDefinition(toolItem));
}

function reviewedTool(
  toolItem: StructuredTool,
  review: ToolReviewPolicy,
): ToolDefinition {
  return toolDefinition(toolItem, { review });
}

type ResolvedToolkitExecution = Awaited<ReturnType<typeof resolveToolkitExecution>>;

async function runToolkitToolCall(
  resources: ResolvedToolkitExecution,
  toolCall: { id?: string; name: string; args: Record<string, unknown> }
    | Array<{ id?: string; name: string; args: Record<string, unknown> }>,
) {
  const toolCalls = Array.isArray(toolCall) ? toolCall : [toolCall];
  return createSubagent({
    model: new FakeToolCallingModel({
      toolCalls: [toolCalls as never, []],
    }),
    tools: resources.tools,
    middleware: resources.middleware,
    promptSections: [],
    operations: collectToolkitOperations(resources.toolkits),
    messages: [new HumanMessage(`call ${toolCalls.map((call) => call.name).join(', ')}`)],
  });
}

function readToolMessageContent(messages: unknown[], toolCallId: string) {
  const message = messages.find((item): item is ToolMessage =>
    item instanceof ToolMessage
    && item.tool_call_id === toolCallId);
  return message?.content;
}

test('orchestrator state channels encode lifecycle prefixes in their names', () => {
  const invalidChannels = ORCHESTRATOR_STATE_CHANNEL_NAMES.filter((name) =>
    name !== 'messages'
    && name !== 'traceId'
    && !/^(session|task|run)/.test(name),
  );

  assert.deepEqual(invalidChannels, []);
  assert.equal(ORCHESTRATOR_STATE_CHANNEL_NAMES.includes('runPendingFinalReply'), false);
  assert.equal(ORCHESTRATOR_STATE_CHANNEL_NAMES.includes('runPlannerSession'), true);
  assert.equal(ORCHESTRATOR_STATE_CHANNEL_NAMES.includes('runCapabilityPlan'), false);
  assert.equal(ORCHESTRATOR_STATE_CHANNEL_NAMES.includes('runCapabilityDisclosure'), false);
});

test('run identity is fresh while task trace identity can be supplied by the caller', () => {
  const first = buildOrchestratorRunInput([new HumanMessage('first')], {
    traceId: 'task-trace-1',
  });
  const resumed = buildOrchestratorRunInput([new HumanMessage('resume')], {
    traceId: first.traceId,
    activeDelegationTransition: 'resume_active',
  });

  assert.equal(first.traceId, 'task-trace-1');
  assert.equal(resumed.traceId, first.traceId);
  assert.notEqual(resumed.runId, first.runId);
  assert.equal('runPlannerSession' in first ? first.runPlannerSession : undefined, null);
  assert.equal('runPlannerSession' in resumed, false);
});

function readToolMessages(messages: unknown[]) {
  return messages.filter((item): item is ToolMessage => item instanceof ToolMessage);
}

const testActor: AgentActor = {
  petId: 'pet-1',
  userId: 'user-1',
  name: '小白',
  personality: '友好',
  stage: 'adult',
  species: 'cat',
};

function scriptedPlannerTask(
  task: string,
  remainingPlan: Array<{ capability: string; task: string }> = [],
) {
  return {
    tasks: [{ capability: '', task }, ...remainingPlan],
  };
}

function scriptedPlannerCapability(capabilityName: string) {
  return { capabilityName };
}

function goalDoneDecision() {
  return { outcome: 'goal_done', gap_note: null };
}

function userInputRequiredDecision() {
  return {
    outcome: 'user_input_required',
    question: '请选择将报告发送到邮件还是项目群？',
    gap_note: null,
  };
}

function taskDoneDecision(gapNote: string | null = '当前任务已完成，但用户目标仍有后续步骤。') {
  return { outcome: 'task_done', gap_note: gapNote };
}

function continueDecision(gapNote: string | null = '当前 delegated task 还未达标，继续执行。') {
  return { outcome: 'continue', gap_note: gapNote };
}

test('execution boundary routes through capabilityPlanner before the next task', async () => {
  const plannerInputs: CapabilityPlannerInput[] = [];
  let answerMessages: BaseMessage[] = [];
  const routeModel = {
    invoke: async (messages: BaseMessage[]) => {
      answerMessages = messages;
      return new AIMessage('final summary');
    },
  } as unknown as AgentModels['act'];
  const capabilityPlannerRunner: CapabilityPlannerRunner = {
    async invoke(input) {
      plannerInputs.push(input);
      if (plannerInputs.length === 1) {
        return {
          action: 'execute_plan',
          tasks: [{
            capability: 'explore',
            task: '读取 issue #269 并提炼需求点。',
          }],
          capabilityDisclosure: {
            ...input.capabilityDisclosure,
            disclosedCapabilityNames: ['explore'],
            emptySearchRounds: 1,
          },
        };
      }
      if (plannerInputs.length === 3) {
        return { action: 'goal_done', tasks: [] };
      }
      return {
        action: 'advance_plan',
        tasks: [{
          capability: 'explore',
          task: '检索本地实现与 git log，判断需求点是否已覆盖。',
        }],
      };
    },
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeListChatModel({
        responses: [
          'issue #269 需求点：需要检查本地实现。',
          '本地实现与 git log 已检查，可以汇总结论。',
        ],
        sleep: 0,
      }),
    },
    actor: testActor,
    capabilityPlannerRunner,
  });

  const dynamicSystemContext = new SystemMessage('DYNAMIC_WIKI_SYSTEM_CONTEXT');
  const compactionContext = createContextCompactionMessage('FRAMEWORK_COMPACTION_CONTEXT', 8);
  const state = await graph.invoke(buildOrchestratorRunInput([
    dynamicSystemContext,
    compactionContext,
    new HumanMessage('看 issue #269，再查本地实现，最后总结。'),
  ]), {
    configurable: {
      thread_id: 'stage-b-task-done-loop',
      actor: testActor,
      capabilities: [capability('explore', '通用探索、调查、代码库理解 capability。')],
      allowedCapabilityNames: ['explore'],
    },
  }) as OrchestratorStateType;

  assert.equal(plannerInputs.length, 3);
  const entryPlannerInput = plannerInputs[0];
  const boundaryPlannerInput = plannerInputs[1];
  assert.equal(entryPlannerInput?.mode, 'entry');
  assert.equal(boundaryPlannerInput?.mode, 'boundary');
  assert.deepEqual(boundaryPlannerInput?.capabilityDisclosure, {
    registryDigest: entryPlannerInput?.workspace.registryDigest,
    disclosedCapabilityNames: ['explore'],
    emptySearchRounds: 1,
    maxEmptySearchRounds: 2,
    status: 'open',
  });
  assert.deepEqual(plannerInputs[2]?.capabilityDisclosure, boundaryPlannerInput?.capabilityDisclosure);
  assert.equal(entryPlannerInput?.userRequest, '看 issue #269，再查本地实现，最后总结。');
  assert.deepEqual(boundaryPlannerInput?.userRequest, entryPlannerInput?.userRequest);
  assert.equal(plannerInputs[1]?.activeDelegation?.task, '读取 issue #269 并提炼需求点。');
  assert.match(plannerInputs[1]?.announceAttempts[0]?.result ?? '', /issue #269 需求点/);
  assert.equal(plannerInputs[1]?.announceAttempts.length, 1);
  const secondBoundaryInput = plannerInputs[2];
  const acceptedFirstTaskAnnounce = secondBoundaryInput?.messages.find((message) =>
    getMessageHandoffSource(message)?.delegationId
      === plannerInputs[1]?.activeDelegation?.delegationId);
  assert.ok(acceptedFirstTaskAnnounce);
  assert.equal(secondBoundaryInput?.announceAttempts.length, 1);
  assert.notEqual(
    secondBoundaryInput?.announceAttempts[0]?.messageId,
    getMessageHandoffSource(acceptedFirstTaskAnnounce)?.announceMessageId,
  );
  assert.ok(plannerInputs[1]?.latestAnnounce?.messageId);
  assert.equal(
    plannerInputs[1]?.inputId,
    `announce:${plannerInputs[1]?.activeDelegation?.delegationId}:${plannerInputs[1]?.latestAnnounce?.messageId}`,
  );
  assert.deepEqual(state.runDelegationSummaries.map((item) => item.status), ['completed', 'completed']);
  assert.equal(state.runPlannerSession, null);
  assert.equal(state.runNextDelegation, null);
  assert.equal(state.taskActiveDelegation, null);
  assert.equal(state.taskPlannerContinuation, null);
  assert.equal(state.messages.some((message) =>
    readMessageText(message).includes('<planning_boundary_event')), false);
  const answerInput = readMessageText(answerMessages.at(-1) ?? new HumanMessage(''));
  assert.match(answerInput, /<accepted_results>/);
  assert.equal(answerInput.match(/<accepted_result order=/g)?.length, 2);
  assert.match(answerInput, /issue #269 需求点：需要检查本地实现/);
  assert.ok(
    answerInput.indexOf('读取 issue #269 并提炼需求点')
      < answerInput.indexOf('检索本地实现与 git log，判断需求点是否已覆盖'),
  );
  assert.equal(answerMessages.some((message) => Boolean(getMessageHandoffSource(message))), false);
});

test('a completed single-task goal is accepted by the boundary Planner', async () => {
  const plannerInputs: CapabilityPlannerInput[] = [];
  const routeModel = {
    invoke: async () => new AIMessage('final summary'),
  } as unknown as AgentModels['act'];
  const capabilityPlannerRunner: CapabilityPlannerRunner = {
    async invoke(input) {
      plannerInputs.push(input);
      return {
        action: input.mode === 'entry' ? 'execute_plan' : 'goal_done',
        tasks: input.mode === 'entry'
          ? [{ capability: 'explore', task: '读取 issue #587 状态。' }]
          : [],
      };
    },
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeListChatModel({
        responses: ['issue #587 当前为 open。'],
        sleep: 0,
      }),
    },
    actor: testActor,
    capabilityPlannerRunner,
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('看下 issue #587 现在什么状态。'),
  ]), {
    configurable: {
      thread_id: 'boundary-exhausted-plan',
      actor: testActor,
      capabilities: [capability('explore', '通用探索、调查、代码库理解 capability。')],
      allowedCapabilityNames: ['explore'],
    },
  }) as OrchestratorStateType;

  assert.equal(plannerInputs.length, 2);
  assert.equal(plannerInputs[0]?.mode, 'entry');
  assert.equal(plannerInputs[1]?.mode, 'boundary');
  assert.equal(state.runNextDelegation, null);
  assert.equal(state.runPlannerSession, null);
});

test('Planner boundary returns to capabilityPlanner until the remaining goal is complete', async () => {
  let answerModelInvocations = 0;
  const plannerInputs: CapabilityPlannerInput[] = [];
  const routeModel = {
    invoke: async () => {
      answerModelInvocations += 1;
      return new AIMessage('issue #269 的需求与本地实现检查均已完成，并确认了兼容性要求。');
    },
  } as unknown as AgentModels['act'];
  const capabilityPlannerRunner: CapabilityPlannerRunner = {
    async invoke(input) {
      plannerInputs.push(input);
      if (input.mode === 'entry') {
        return {
          action: 'execute_plan',
          tasks: [{
            capability: 'explore',
            task: '读取 issue #269 并提炼需求点。',
          }, {
            capability: 'explore',
            task: '检索本地实现与 git log。',
          }],
        };
      }
      if (plannerInputs.length === 3) {
        return { action: 'goal_done', tasks: [] };
      }
      return {
        action: 'advance_plan',
        tasks: [{
          capability: 'explore',
          task: '检索本地实现与 git log。',
        }],
      };
    },
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeListChatModel({
        responses: [
          `issue #269 需求点：需要检查本地实现。${'背景信息。'.repeat(4_000)}完整 handoff 末尾约束：必须检查兼容性。`,
          '本地实现与 git log 已检查。',
        ],
        sleep: 0,
      }),
    },
    actor: testActor,
    capabilityPlannerRunner,
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('看 issue #269，再查本地实现。'),
  ]), {
    configurable: {
      thread_id: 'stage-b-task-done-no-plan',
      actor: testActor,
      capabilities: [capability('explore', '通用探索、调查、代码库理解 capability。')],
      allowedCapabilityNames: ['explore'],
    },
  }) as OrchestratorStateType;

  assert.equal(plannerInputs.length, 3);
  assert.deepEqual(plannerInputs.map(({ mode }) => mode), ['entry', 'boundary', 'boundary']);
  assert.deepEqual(plannerInputs[1]?.remainingPlan, [{
    capability: 'explore',
    task: '检索本地实现与 git log。',
  }]);
  assert.equal(plannerInputs[1]?.activeDelegation?.task, '读取 issue #269 并提炼需求点。');
  assert.match(plannerInputs[1]?.announceAttempts[0]?.result ?? '', /issue #269 需求点：需要检查本地实现/);
  assert.doesNotMatch(plannerMessageContextText(plannerInputs[1]), /announce truncated for Planner context/);
  assert.match(plannerInputs[1]?.announceAttempts[0]?.result ?? '', /完整 handoff 末尾约束：必须检查兼容性/);
  assert.equal(answerModelInvocations, 1);
  assert.equal(
    String(state.messages.at(-1)?.content ?? ''),
    'issue #269 的需求与本地实现检查均已完成，并确认了兼容性要求。',
  );
  assert.deepEqual(state.runDelegationSummaries.map((item) => item.status), ['completed', 'completed']);
  assert.equal(state.runPlannerSession, null);
  assert.equal(state.runNextDelegation, null);
  assert.equal(state.taskActiveDelegation, null);
});

test('Planner return routes bounded facts through the answer node', async () => {
  let answerInvocationText = '';
  const model = {
    invoke: async (messages: BaseMessage[]) => {
      answerInvocationText = messages.map((message) => readMessageText(message)).join('\n');
      return new AIMessage('请确认是否要扩大当前 Capability 的可用范围。');
    },
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: {
      act: model,
      observe: model,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
    capabilityPlannerRunner: {
      async invoke(input) {
        if (input.mode === 'boundary') {
          return { action: 'goal_done', tasks: [] };
        }
        return {
          action: 'unavailable',
          tasks: [],
        };
      },
    },
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('帮我读取本地文件'),
  ]), {
    configurable: {
      thread_id: 'missing-executable-capability-routes-answer',
      actor: testActor,
      capabilities: [],
      toolkits: [],
    },
  }) as OrchestratorStateType;

  assert.match(String(mainConversationMessages(state.messages).at(-1)?.content ?? ''), /扩大当前 Capability/);
  assert.doesNotMatch(answerInvocationText, /The compiled Capability registry is empty/);
  assert.match(answerInvocationText, /<reply_mode>blocked<\/reply_mode>/);
  assert.match(answerInvocationText, /<blocked_reason meaning="[^"]+">capability_unavailable<\/blocked_reason>/);
  assert.equal(state.runNextDelegation, null);
  assert.equal(state.taskActiveDelegation, null);
});

test('Entry Planner routes its structured user question through Answer without an active delegation', async () => {
  let answerInvocationText = '';
  let answerInputText = '';
  const question = '请选择部署到生产还是预发布环境？';
  const model = {
    invoke: async (messages: BaseMessage[]) => {
      answerInvocationText = messages.map(readMessageText).join('\n');
      answerInputText = readMessageText(messages.at(-1) ?? new HumanMessage(''));
      return new AIMessage(question);
    },
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: model,
      observe: model,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
    capabilityPlannerRunner: {
      async invoke() {
        return {
          action: 'user_input_required',
          tasks: [],
          userInputRequest: { question },
        };
      },
    },
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('把服务部署到生产或预发布环境，目标由我决定。'),
  ]), {
    configurable: {
      thread_id: 'entry-planner-user-input-question',
      actor: testActor,
      capabilities: [capability('general', 'Deploy after the user selects an environment.')],
      toolkits: [],
    },
  }) as OrchestratorStateType;

  assert.match(answerInvocationText, /<reply_mode>user_input_required<\/reply_mode>/);
  assert.match(answerInvocationText, /<requested_user_input>/);
  assert.match(answerInvocationText, /请选择部署到生产还是预发布环境/);
  assert.doesNotMatch(answerInputText, /<awaiting_user_input_context>/);
  assert.equal(state.taskActiveDelegation, null);
  assert.equal(state.runNextDelegation, null);
  assert.equal(state.runUserInputRequest, null);
});

test('Planner non-commit routes to Answer without inventing a General delegation', async () => {
  let answerInvocationText = '';
  let plannerCalls = 0;
  const model = {
    invoke: async (messages: BaseMessage[]) => {
      answerInvocationText = messages.map(readMessageText).join('\n');
      return new AIMessage('规划没有形成可执行计划，请重新发起这个请求。');
    },
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: model,
      observe: model,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
    capabilityPlannerRunner: {
      async invoke() {
        plannerCalls += 1;
        return {
          plannerStatus: 'incomplete',
          reason: 'terminal_commit_missing',
        };
      },
    },
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('修改当前仓库的 Planner 行为'),
  ]), {
    configurable: {
      thread_id: 'planner-non-commit-routes-answer',
      actor: testActor,
      capabilities: [capability('general', 'General-purpose capability.')],
      toolkits: [],
    },
  }) as OrchestratorStateType;

  assert.equal(plannerCalls, 1);
  assert.match(String(mainConversationMessages(state.messages).at(-1)?.content ?? ''), /规划没有形成/);
  assert.match(answerInvocationText, /<reply_mode>blocked<\/reply_mode>/);
  assert.match(answerInvocationText, /<blocked_reason meaning="[^"]+">planner_incomplete<\/blocked_reason>/);
  assert.equal(state.runNextDelegation, null);
  assert.equal(state.taskActiveDelegation, null);
  assert.equal(state.runDelegationSummaries.length, 0);
});

test('Planner boundary non-commit preserves the active delegation and remaining plan', async () => {
  let plannerInput: CapabilityPlannerInput | null = null;
  let answerInvocationText = '';
  const model = {
    invoke: async (messages: BaseMessage[]) => {
      answerInvocationText = messages.map(readMessageText).join('\n');
      return new AIMessage('规划没有形成下一步提交，当前任务和后续计划保持不变。');
    },
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: model,
      observe: model,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
    capabilityPlannerRunner: {
      async invoke(input) {
        plannerInput = input;
        return {
          plannerStatus: 'incomplete',
          reason: 'terminal_commit_missing',
        };
      },
    },
  });
  const remainingPlan = [{
    capability: 'release',
    task: '发布已经验证的改动。',
  }];
  const input = {
    ...buildOrchestratorRunInput([
      new HumanMessage('继续当前任务'),
    ], { activeDelegationTransition: 'resume_active' }),
    taskActiveDelegation: null as TaskActiveDelegation | null,
  } as OrchestratorStateType;
  input.runDelegationSummaries = [{
    id: 'active-1',
    lane: 'capability:general',
    task: '验证当前改动。',
    status: 'progress',
    resultPreview: '验证尚未形成可接受的边界决定。',
  }];
  input.taskActiveDelegation = {
    id: 'active-1',
    lane: 'capability:general',
    task: '验证当前改动。',
    contextSummary: null,
    runId: input.runId,
    traceId: input.traceId,
    status: 'awaiting_decision',
    resultPreview: '验证尚未形成可接受的边界决定。',
    userRequest: '验证当前改动，然后发布。',
  };
  input.taskPlannerContinuation = {
    traceId: input.taskActiveDelegation.traceId,
    userRequest: input.taskActiveDelegation.userRequest,
    activeDelegationId: input.taskActiveDelegation.id,
    remainingPlan,
  };

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'planner-boundary-non-commit-preserves-plan',
      actor: testActor,
      capabilities: [
        capability('general', 'General-purpose capability.'),
        capability('release', '发布已经验证的改动。'),
      ],
      toolkits: [],
    },
  }) as OrchestratorStateType;

  const observedPlannerInput = plannerInput as CapabilityPlannerInput | null;
  assert.equal(observedPlannerInput?.mode, 'boundary');
  assert.deepEqual(observedPlannerInput?.remainingPlan, remainingPlan);
  assert.match(answerInvocationText, /<blocked_reason meaning="[^"]+">planner_incomplete<\/blocked_reason>/);
  assert.equal(state.taskActiveDelegation?.id, 'active-1');
  assert.deepEqual(state.taskPlannerContinuation?.remainingPlan, remainingPlan);
  assert.equal(state.runNextDelegation, null);
});

test('Planner boundary ordinary text cannot enter root messages through the runner seam', async () => {
  let answerInvocationText = '';
  const plannerAnswer = [
    '网络检查已经完成：en1 已获取 IP，外网连通正常。',
    '完整诊断证据。'.repeat(100),
    'Handoff 根因是 Manatee/CDP circle failure -5403。',
  ].join('');
  const model = {
    invoke: async (messages: BaseMessage[]) => {
      answerInvocationText = messages.map(readMessageText).join('\n');
      return new AIMessage('网络正常；Handoff 根因是 Manatee/CDP -5403。');
    },
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: model,
      observe: model,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
    capabilityPlannerRunner: {
      async invoke() {
        return {
          plannerStatus: 'incomplete',
          reason: 'terminal_commit_missing',
        };
      },
    },
  });
  const remainingPlan = [{
    capability: 'release',
    task: '发布已经验证的改动。',
  }];
  const input = {
    ...buildOrchestratorRunInput([
      new HumanMessage('重新检查网络并核对 Handoff。'),
    ], { activeDelegationTransition: 'resume_active' }),
    taskActiveDelegation: null as TaskActiveDelegation | null,
  } as OrchestratorStateType;
  input.runDelegationSummaries = [{
    id: 'active-network-check',
    lane: 'capability:general',
    task: '重新检查网络并核对 Handoff。',
    status: 'progress',
    resultPreview: '网络检查已完成。',
  }];
  input.taskActiveDelegation = {
    id: 'active-network-check',
    lane: 'capability:general',
    task: '重新检查网络并核对 Handoff。',
    contextSummary: null,
    runId: input.runId,
    traceId: input.traceId,
    status: 'awaiting_decision',
    resultPreview: '网络检查已完成。',
    userRequest: '重新检查网络并核对 Handoff。',
  };
  input.taskPlannerContinuation = {
    traceId: input.taskActiveDelegation.traceId,
    userRequest: input.taskActiveDelegation.userRequest,
    activeDelegationId: input.taskActiveDelegation.id,
    remainingPlan,
  };

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'planner-boundary-direct-answer-fallback',
      actor: testActor,
      capabilities: [
        capability('general', 'General-purpose capability.'),
        capability('release', '发布已经验证的改动。'),
      ],
      toolkits: [],
    },
  }) as OrchestratorStateType;

  assert.match(answerInvocationText, /<blocked_reason meaning="[^"]+">planner_incomplete<\/blocked_reason>/);
  assert.equal(answerInvocationText.includes(plannerAnswer), false);
  assert.equal(state.messages.some((message) => readMessageText(message).includes(plannerAnswer)), false);
  assert.equal(state.taskActiveDelegation?.id, 'active-network-check');
  assert.deepEqual(state.taskPlannerContinuation?.remainingPlan, remainingPlan);
});

test('an explicit resume without Planner state initializes a fresh session', async () => {
  let plannerCalls = 0;
  let observedSessionRunId: string | null = null;
  const model = {
    invoke: async () => new AIMessage('must not run'),
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: { act: model },
    actor: testActor,
    capabilityPlannerRunner: {
      async invoke(plannerInput) {
        plannerCalls += 1;
        observedSessionRunId = plannerInput.plannerSession.runId;
        return { action: 'goal_done', tasks: [] };
      },
    },
  });
  const input = {
    ...buildOrchestratorRunInput([
      new HumanMessage('继续旧任务'),
    ], { activeDelegationTransition: 'resume_active' }),
    taskActiveDelegation: null as TaskActiveDelegation | null,
  };
  input.taskActiveDelegation = {
    id: 'legacy-active',
    lane: 'capability:general',
    task: '继续旧任务',
    contextSummary: null,
    runId: input.runId,
    traceId: input.traceId,
    status: 'awaiting_decision',
    resultPreview: '旧版本结果',
    userRequest: '继续旧任务',
  };

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'legacy-planner-disclosure-checkpoint',
      actor: testActor,
      capabilities: [capability('general', 'General-purpose capability.')],
      toolkits: [],
    },
  }) as OrchestratorStateType;

  assert.equal(plannerCalls, 1);
  assert.equal(observedSessionRunId, input.runId);
  assert.equal(state.runRuntimeFailure, null);
  assert.equal(state.taskActiveDelegation?.id, 'legacy-active');
  assert.equal(state.runPlannerSession, null);
});

test('capability planner reports an empty compiled registry without inventing General', async () => {
  let plannerMode: CapabilityPlannerInput['mode'] | null = null;
  let plannerCapabilityNames: readonly string[] = [];
  const model = {
    invoke: async () => new AIMessage('当前没有可用 Capability。'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: model,
      observe: model,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
    capabilityPlannerRunner: {
      async invoke(input) {
        plannerMode = input.mode;
        plannerCapabilityNames = input.workspace.capabilityNames;
        return {
          action: 'unavailable',
          tasks: [],
        };
      },
    },
  });

  await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('完成一个需要执行能力的任务'),
  ]), {
    configurable: {
      thread_id: 'empty-capability-registry-planner-facts',
      actor: testActor,
      capabilities: [],
      toolkits: [],
    },
  });

  assert.equal(plannerMode, 'entry');
  assert.deepEqual(plannerCapabilityNames, []);
});

test('Capability Planner return is materialized without a second semantic policy check', async () => {
  const model = {
    invoke: async () => new AIMessage('done'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: { act: model },
    actor: testActor,
    capabilityPlannerRunner: {
      async invoke() {
        return {
          action: 'unavailable',
          tasks: [],
        };
      },
    },
  });

  const result = await graph.invoke(buildOrchestratorRunInput([
      new HumanMessage('完成普通工作区任务'),
  ]), {
    configurable: {
      thread_id: 'general-fallback-model-policy',
      actor: testActor,
      capabilities: [capability('general', '处理普通任务。')],
      toolkits: [],
    },
  });

  assert.equal(result.messages.at(-1)?.content, 'done');
});

test('allowedCapabilityNames scopes the immutable Planner workspace', async () => {
  let plannerCapabilityNames: readonly string[] = [];
  const model = {
    invoke: async () => new AIMessage('answered'),
  } as unknown as AgentModels['act'];
  const capabilityPlannerRunner: CapabilityPlannerRunner = {
    async invoke(input) {
      plannerCapabilityNames = input.workspace.capabilityNames;
      return {
        action: 'unavailable',
        tasks: [],
      };
    },
  };

  const graph = createOrchestratorGraph({
    models: {
      act: model,
      observe: model,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
    capabilityPlannerRunner,
  });
  const input = buildOrchestratorRunInput([new HumanMessage('做一支讲秋日食材的短视频')]);

  await graph.invoke(input, {
    configurable: {
      thread_id: 'forced-cap-thread',
      actor: testActor,
      capabilities: [
        capability('studio_plan', 'Planner 唯一的目标:把用户请求拆解为一份 plan。'),
        capability('other_cap', '某个无关 capability。'),
      ],
      tools: [],
      allowedCapabilityNames: ['studio_plan'],
    },
  });

  assert.deepEqual(plannerCapabilityNames, ['studio_plan']);
});

test('Capability Planner materializer rejects selections outside the workspace', async () => {
  const model = {
    invoke: async () => new AIMessage('answered'),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: model,
      observe: model,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
    capabilityPlannerRunner: {
      async invoke(input) {
        assert.equal(input.mode, 'entry');
        return {
          action: 'execute_plan',
          tasks: [{
            capability: 'not_registered',
            task: '读取 src/index.ts。',
          }],
        };
      },
    },
  });

  await assert.rejects(
    graph.invoke(
      buildOrchestratorRunInput([new HumanMessage('帮我读取 src/index.ts')]),
      {
        configurable: {
          thread_id: 'planner-selection-outside-workspace',
          actor: testActor,
          capabilities: [capability('general', '普通代码任务。')],
          tools: [],
        },
      },
    ),
    /outside the immutable workspace/,
  );
});

test('Capability Planner owns the executable task boundary at entry', async () => {
  const model = {
    invoke: async () => new AIMessage('answered'),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: model,
      observe: model,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
    capabilityPlannerRunner: {
      async invoke(input) {
        if (input.mode === 'boundary') {
          return { action: 'goal_done', tasks: [] };
        }
        return {
          action: 'execute_plan',
          tasks: [{
            capability: 'general',
            task: '检查 src/index.ts 并整理其公开接口。',
          }],
        };
      },
    },
  });

  const state = await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage('帮我看看 src/index.ts')]),
    {
      configurable: {
        thread_id: 'planner-owns-entry-task-boundary',
        actor: testActor,
        capabilities: [capability('general', '普通代码任务。')],
        tools: [],
      },
    },
  ) as OrchestratorStateType;

  assert.equal(
    state.runDelegationSummaries[0]?.task,
    '检查 src/index.ts 并整理其公开接口。',
  );
});

test('a completed subagent announce reaches the decision, then Answer summarizes the result', async () => {
  let plannerInput: CapabilityPlannerInput | null = null;
  let answerModelInvocations = 0;
  let answerInput: BaseMessage[] = [];
  const model = {
    invoke: async (messages: BaseMessage[]) => {
      answerModelInvocations += 1;
      answerInput = messages;
      return new AIMessage('文件读取和 lint 检查已完成，lint 已通过。');
    },
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({ invoke: async () => goalDoneDecision() }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: {
      act: model,
      decision: new FakeListChatModel({ responses: ['直接回答当前请求。'], sleep: 0 }),
      observe: model,
    },
    actor: testActor,
    capabilityPlannerRunner: {
      async invoke(input) {
        plannerInput = input;
        return { action: 'goal_done', tasks: [] };
      },
    },
  });
  const currentAnnounceText = [
    '文件读取完成，lint 已通过。',
    'A'.repeat(1400),
    'END_OF_FULL_SUBAGENT_RESULT',
  ].join('\n\n');
  const input = {
    ...buildOrchestratorRunInput([
      new HumanMessage('读取文件并运行 lint'),
    ], { activeDelegationTransition: 'resume_active' }),
    taskActiveDelegation: null as TaskActiveDelegation | null,
  };
  const currentAnnounce = createPrivateAnnounce({
    lane: 'capability:general',
    runId: input.runId,
    completionReason: 'natural',
    delegationId: 'task-1',
    task: '读取文件并运行 lint',
    result: currentAnnounceText,
  });
  input.messages.push(currentAnnounce);
  input.runDelegationSummaries = [{
    id: 'task-1',
    lane: 'capability:general',
    task: '读取文件并运行 lint',
    status: 'progress',
    resultPreview: currentAnnounceText,
  }];
  input.taskActiveDelegation = {
    id: 'task-1',
    lane: 'capability:general',
    task: '读取文件并运行 lint',
    contextSummary: null,
    runId: input.runId,
    traceId: input.traceId,
    status: 'awaiting_decision',
    resultPreview: currentAnnounceText,
    userRequest: '读取文件并运行 lint。',
  };

  const result = await graph.invoke(input, {
    configurable: {
      thread_id: 'test-delegation-outcome',
      actor: testActor,
      capabilities: [capability('content_writer', '生成通用内容草稿。')],
      tools: [],
    },
  });

  const observedPlannerInput = plannerInput as CapabilityPlannerInput | null;
  assert.equal(observedPlannerInput?.mode, 'boundary');
  assert.match(observedPlannerInput?.announceAttempts[0]?.result ?? '', /文件读取完成，lint 已通过/);
  assert.match(observedPlannerInput?.announceAttempts[0]?.result ?? '', /END_OF_FULL_SUBAGENT_RESULT/);
  assert.equal(answerModelInvocations, 1);
  assert.equal(result.messages.at(-1)?.content, '文件读取和 lint 检查已完成，lint 已通过。');
  assert.match(answerInput.map(readMessageText).join('\n'), /END_OF_FULL_SUBAGENT_RESULT/);
  assert.match(String(answerInput.at(-1)?.content), /<reply_mode>goal_done<\/reply_mode>/);
  assert.equal(
    result.messages.some((message) => String(message.content).includes('END_OF_FULL_SUBAGENT_RESULT')),
    true,
  );
});

test('answer node still sees compacted older results when the user asks to re-show them', async () => {
  let answerInput: BaseMessage[] = [];
  const model = {
    invoke: async (messages: unknown[]) => {
      answerInput = messages as BaseMessage[];
      return new AIMessage('answered');
    },
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
    withStructuredOutput: () => ({
      invoke: async () => ({ action: 'unavailable', tasks: [] }),
    }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: { act: model, observe: model },
    actor: testActor,
  });
  // After compaction the older result survives only as the canonical context message.
  const summary = createContextCompactionMessage(
    '压缩摘要：之前 explore 调研得到 SWE-bench Verified GPT-5.5 88.7%。COMPACTED_RESULT_MARKER',
    14,
  );
  const input = buildOrchestratorRunInput([
    summary,
    new HumanMessage('把之前的调研结果再发一下'),
  ]);

  const result = await graph.invoke(input, {
    configurable: {
      thread_id: 'answer-sees-compaction-summary',
      actor: testActor,
      capabilities: [],
      tools: [],
    },
  });

  assert.equal(result.messages.at(-1)?.content, 'answered');
  // Answer is a closer and receives only <answer_input>, so the compaction
  // summary does not reach it. Re-showing an older result is a conversational
  // request: Entry Answer owns it, and it has the summary in its own view.
  assert.equal(answerInput.some(isContextCompactionMessage), false);
  assert.doesNotMatch(answerInput.map(readMessageText).join('\n'), /COMPACTED_RESULT_MARKER/);
  assert.equal(
    mainConversationMessages(result.messages).some(isContextCompactionMessage),
    true,
    'the summary must survive in canonical history for Entry Answer',
  );
});

test('delegation goal_done summarizes and preserves the handed-off result', async () => {
  let answerModelInvocations = 0;
  let answerInput: BaseMessage[] = [];
  const announceMarker = 'Vibe Coding 模型排行榜：1. Claude Sonnet 4；2. GPT-5；3. Gemini 2.5 Pro。';
  const routeModel = {
    invoke: async (messages: BaseMessage[]) => {
      answerModelInvocations += 1;
      answerInput = messages;
      return new AIMessage('Vibe Coding 模型排行榜已整理：1. Claude Sonnet 4；2. GPT-5；3. Gemini 2.5 Pro。');
    },
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => goalDoneDecision(),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: { act: routeModel },
    actor: testActor,
  });
  const input = {
    ...buildOrchestratorRunInput([
      new HumanMessage('帮我列一个目前 vibecoding 的模型排行榜。'),
    ], { activeDelegationTransition: 'resume_active' }),
    taskActiveDelegation: null as TaskActiveDelegation | null,
  };
  const announceText = 'Vibe Coding 模型排行榜：1. Claude Sonnet 4；2. GPT-5；3. Gemini 2.5 Pro。';
  const announceMessage = createPrivateAnnounce({
    lane: 'capability:general',
    runId: input.runId,
    delegationId: 'task-1',
    task: '搜索并整理 vibecoding 模型排行榜。',
    result: announceText,
  });
  input.messages.push(announceMessage);
  input.runDelegationSummaries = [{
    id: 'task-1',
    lane: 'capability:general',
    task: '搜索并整理 vibecoding 模型排行榜。',
    status: 'completed',
    resultPreview: announceText,
  }];
  input.taskActiveDelegation = {
    id: 'task-1',
    lane: 'capability:general',
    task: '搜索并整理 vibecoding 模型排行榜。',
    contextSummary: null,
    runId: input.runId,
    traceId: input.traceId,
    status: 'awaiting_decision',
    resultPreview: announceText,
    userRequest: '列出目前 Vibe Coding 的模型排行榜。',
  };

  const result = await graph.invoke(input, {
    configurable: {
      thread_id: 'delegation-outcome-leak-fallback',
      actor: testActor,
      capabilities: [],
      toolkits: [],
    },
  });
  const finalMessageText = String(result.messages.at(-1)?.content ?? '');

  assert.equal(answerModelInvocations, 1);
  assert.equal(
    finalMessageText,
    'Vibe Coding 模型排行榜已整理：1. Claude Sonnet 4；2. GPT-5；3. Gemini 2.5 Pro。',
  );
  assert.match(answerInput.map(readMessageText).join('\n'), /Claude Sonnet 4/);
  assert.match(String(answerInput.at(-1)?.content), /<reply_mode>goal_done<\/reply_mode>/);
  assert.equal(
    result.messages.some((message) => String(message.content).includes(announceMarker)),
    true,
  );
});

test('user_input_required returns control without claiming delegation completion', async () => {
  let answerMessages: BaseMessage[] = [];
  const routeModel = {
    invoke: async (messages: unknown[]) => {
      answerMessages = messages as BaseMessage[];
      return new AIMessage('报告已经准备好，但还没有发送。请选择发送到邮件还是项目群。');
    },
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => userInputRequiredDecision(),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: { act: routeModel },
    actor: testActor,
  });
  const input = {
    ...buildOrchestratorRunInput([
      new HumanMessage('根据我的选择，把已经完成的报告发送到邮件或项目群。'),
    ], { activeDelegationTransition: 'resume_active' }),
    taskActiveDelegation: null as TaskActiveDelegation | null,
  } as OrchestratorStateType;
  const task = '确认发送渠道并发送已经完成的报告';
  const announceText = '报告已经完成，但用户尚未选择邮件或项目群，当前无法继续发送。';
  const announceMessage = createPrivateAnnounce({
    lane: 'capability:general',
    runId: input.runId,
    completionReason: 'natural',
    delegationId: 'task-user-choice',
    task,
    result: announceText,
  });
  input.messages.push(
    ...interruptedLaneMessages({
      delegationId: 'task-user-choice',
      runId: input.runId,
    }),
    announceMessage,
  );
  input.runDelegationSummaries = [{
    id: 'task-user-choice',
    lane: 'capability:general',
    task,
    status: 'progress',
    resultPreview: announceText,
  }];
  input.taskActiveDelegation = {
    id: 'task-user-choice',
    lane: 'capability:general',
    task,
    contextSummary: null,
    runId: input.runId,
    traceId: input.traceId,
    status: 'awaiting_decision',
    resultPreview: announceText,
    userRequest: '根据用户选择发送已经完成的报告。',
  };
  input.sessionCapabilityArtifacts = [{
    id: 'artifact-awaiting-user-choice',
    threadId: 'delegation-outcome-user-input-required',
    capabilityId: 'general',
    delegationId: 'task-user-choice',
    runId: input.runId,
    kind: 'report',
    mimeType: 'text/markdown',
    uri: 'capability-artifact://thread/user-choice/report',
    title: '待发送报告',
    preview: '报告已生成，等待选择发送渠道。',
    sizeBytes: 42,
    createdAt: '2026-07-28T00:00:00.000Z',
  }];

  const result = await graph.invoke(input, {
    configurable: {
      thread_id: 'delegation-outcome-user-input-required',
      actor: testActor,
      capabilities: [],
      toolkits: [],
    },
  }) as OrchestratorStateType;

  assert.equal(
    result.messages.at(-1)?.content,
    '报告已经准备好，但还没有发送。请选择发送到邮件还是项目群。',
  );
  assert.deepEqual(
    answerMessages.map((message) => message._getType()),
    ['system', 'human'],
  );
  const answerSystem = String(answerMessages[0]?.content ?? '');
  const answerFacts = String(answerMessages.at(-1)?.content ?? '');
  assert.doesNotMatch(answerSystem, /确认发送渠道|报告已经完成|artifact-awaiting-user-choice/);
  assert.match(answerFacts, /<reply_mode>user_input_required<\/reply_mode>/);
  assert.match(answerFacts, /<requested_user_input>/);
  assert.match(answerFacts, /请选择将报告发送到邮件还是项目群/);
  assert.match(answerFacts, /<awaiting_user_input_context>/);
  assert.match(answerFacts, /报告已经完成，但用户尚未选择邮件或项目群/);
  assert.match(answerFacts, /<artifacts>/);
  assert.match(answerFacts, /capability-artifact:\/\/thread\/user-choice\/report/);
  assert.equal(result.runDelegationSummaries[0]?.status, 'progress');
  assert.equal(result.taskActiveDelegation?.id, 'task-user-choice');
  assert.equal(result.taskActiveDelegation?.status, 'awaiting_decision');
  assert.equal(
    selectCapabilityHistory(
      result.messages,
      'capability:general',
      input.runId,
      'task-user-choice',
    ).some((message) => message instanceof ToolMessage),
    true,
  );
  assert.equal(
    result.messages.some((message) =>
      getMessageHandoffSource(message)?.delegationId === 'task-user-choice'),
    false,
  );
  assert.equal(
    mainConversationMessages(result.messages).some((message) =>
      String(message.content).includes('capability-artifact://thread/user-choice/report')),
    false,
  );
});

test('capability errors retain the active delegation and lane without a handoff', async () => {
  const activeDelegation: TaskActiveDelegation = {
    id: 'task-capability-error',
    lane: 'capability:general',
    task: '继续处理会失败的 delegated task',
    contextSummary: null,
    runId: 'run-capability-error',
    traceId: 'trace-capability-error',
    status: 'pending',
    resultPreview: null,
    userRequest: '继续处理当前 delegated task，并保留失败状态。',
  };
  const messages = interruptedLaneMessages({
    delegationId: activeDelegation.id,
    runId: activeDelegation.runId,
  });
  const failingCapability: AgentCapability = {
    ...capability('general', 'General-purpose capability.'),
    lifecycle: {
      finalize: () => {
        throw new Error('capability finalize failed');
      },
    },
  };
  const graph = createOrchestratorGraph({
    models: {
      act: new FakeListChatModel({ responses: ['unused'], sleep: 0 }),
      subagent: new FakeListChatModel({
        responses: ['执行产生了结果，但 finalize 随后失败。'],
        sleep: 0,
      }),
    },
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const config = {
    configurable: {
      thread_id: 'delegation-capability-error',
      actor: testActor,
      capabilities: [failingCapability],
      toolkits: [],
    },
  };
  await graph.updateState(config, {
    messages,
    runId: activeDelegation.runId,
    taskActiveDelegation: activeDelegation,
    runDelegationSummaries: [{
      id: activeDelegation.id,
      lane: activeDelegation.lane,
      task: activeDelegation.task,
      status: 'progress',
      resultPreview: null,
    }],
  });

  await assert.rejects(
    graph.invoke(
      buildOrchestratorRunInput(
        [new HumanMessage('继续执行')],
        { activeDelegationTransition: 'resume_active' },
      ),
      config,
    ),
    /capability finalize failed/,
  );

  const checkpoint = await graph.getState(config);
  const checkpointState = checkpoint.values as OrchestratorStateType;
  assert.equal(checkpointState.taskActiveDelegation?.id, activeDelegation.id);
  assert.equal(
    checkpointState.taskActiveDelegation?.runId,
    activeDelegation.runId,
  );
  assert.equal(
    selectCapabilityHistory(
      checkpointState.messages,
      activeDelegation.lane,
      activeDelegation.runId,
      activeDelegation.id,
    ).some((message) => message instanceof ToolMessage),
    true,
  );
  assert.equal(
    checkpointState.messages.some((message) => getMessageHandoffSource(message)),
    false,
  );
  assert.equal(checkpointState.runPlannerSession, null);
  assert.equal(
    checkpointState.taskPlannerContinuation?.activeDelegationId,
    activeDelegation.id,
  );
  assert.equal(checkpointState.runIterationCount, 0);
  assert.equal(checkpointState.runTerminalError?.node, 'capability');
  assert.equal(checkpointState.runTerminalError?.message, 'capability finalize failed');
});

test('planner errors checkpoint run-scoped cleanup before they are rethrown', async () => {
  const graph = createOrchestratorGraph({
    models: {
      act: new FakeListChatModel({ responses: ['unused'], sleep: 0 }),
    },
    actor: testActor,
    checkpoint: new MemorySaver(),
    capabilityPlannerRunner: {
      invoke: async () => {
        throw new Error('planner failed');
      },
    },
  });
  const config = {
    configurable: {
      thread_id: 'planner-error-cleanup',
      actor: testActor,
      capabilities: [capability('general', 'General-purpose capability.')],
      toolkits: [],
    },
  };

  await assert.rejects(
    graph.invoke(buildOrchestratorRunInput([
      new HumanMessage('执行会触发 Planner 失败的任务'),
    ]), config),
    /planner failed/,
  );

  const checkpoint = await graph.getState(config);
  const state = checkpoint.values as OrchestratorStateType;
  assert.equal(state.runPlannerSession, null);
  assert.equal(state.taskPlannerContinuation, null);
  assert.equal(state.runTerminalError?.node, 'capabilityPlanner');
});

test('answer errors checkpoint run-scoped cleanup before they are rethrown', async () => {
  const answerError = Object.assign(new Error('answer failed'), {
    lc_error_code: 'MODEL_RATE_LIMIT',
  });
  const answerModel = {
    invoke: async () => {
      throw answerError;
    },
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
    withStructuredOutput: () => ({
      invoke: async () => ({ action: 'unavailable', tasks: [] }),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: { act: answerModel },
    actor: testActor,
    checkpoint: new MemorySaver(),
    capabilityPlannerRunner: {
      invoke: async () => ({ action: 'unavailable', tasks: [] }),
    },
  });
  const config = {
    configurable: {
      thread_id: 'answer-error-cleanup',
      actor: testActor,
      capabilities: [],
      toolkits: [],
    },
  };

  await assert.rejects(
    graph.invoke(buildOrchestratorRunInput([
      new HumanMessage('回答会失败的任务'),
    ]), config),
    (error) => error instanceof Error
      && error.message === 'answer failed'
      && (error as Error & { lc_error_code?: string }).lc_error_code === 'MODEL_RATE_LIMIT',
  );

  const checkpoint = await graph.getState(config);
  const state = checkpoint.values as OrchestratorStateType;
  assert.equal(state.runPlannerSession, null);
  assert.equal(state.taskPlannerContinuation, null);
  assert.equal(state.runTerminalError?.node, 'answer');
  assert.equal(state.runTerminalError?.langChainErrorCode, 'MODEL_RATE_LIMIT');
});

test('answer filters private delegation messages by lane without parsing message text', async () => {
  let answerInput = '';
  const model = {
    invoke: async (messages: unknown[]) => {
      answerInput = (messages as Array<{ content?: unknown }>)
        .map((message) => String(message.content ?? ''))
        .join('\n');
      return new AIMessage('正常回复');
    },
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
    withStructuredOutput: () => ({
      invoke: async () => ({ action: 'unavailable', tasks: [] }),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: { act: model, observe: model },
    actor: testActor,
  });

  const privateMessage = new AIMessage('正文完全普通，但 metadata 表明它属于 delegation lane。');
  setAgentMessageMetadata(privateMessage, {
    lane: 'capability:general',
    runId: 'answer-run',
    delegationId: 'answer-task',
  });
  const briefingShapedConversation = new AIMessage('【委派简报】\n- 这是用户可见的普通历史内容');
  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('之前做了什么？'),
    privateMessage,
    briefingShapedConversation,
    new HumanMessage('直接回答我。'),
  ]), {
    configurable: { thread_id: 'answer-filters-lane-briefing', actor: testActor },
  }) as OrchestratorStateType;

  assert.equal(state.messages.at(-1)?.content, '正常回复');
  // Answer receives no history, so nothing from either message may reach it.
  assert.doesNotMatch(answerInput, /metadata 表明它属于 delegation lane/);
  assert.doesNotMatch(answerInput, /这是用户可见的普通历史内容/);
  // The lane distinction itself is still metadata-driven, not text-shaped: the
  // briefing-shaped conversation message stays in canonical history, the
  // lane-tagged one does not.
  const canonical = mainConversationMessages(state.messages);
  assert.equal(canonical.includes(briefingShapedConversation), true);
  assert.equal(canonical.includes(privateMessage), false);
});

test('answer returns model output unchanged without classifying its text shape', async () => {
  let answerCallCount = 0;
  const modelOutput = '<delegation_briefing role="task_boundary">\n  <task>用户要求展示的正文</task>\n</delegation_briefing>';
  const model = {
    invoke: async () => {
      answerCallCount += 1;
      return new AIMessage(modelOutput);
    },
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
    withStructuredOutput: () => ({
      invoke: async () => ({ action: 'unavailable', tasks: [] }),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: model,
      decision: new FakeListChatModel({ responses: ['回答当前版本问题。'], sleep: 0 }),
      observe: model,
    },
    actor: testActor,
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('你知道自己的版本吗？'),
  ]), {
    configurable: { thread_id: 'answer-rejects-briefing-output', actor: testActor },
  }) as OrchestratorStateType;

  assert.equal(answerCallCount, 1);
  assert.equal(state.messages.at(-1)?.content, modelOutput);
});

test('answer does not special-case briefing-shaped output', async () => {
  let answerCallCount = 0;
  const modelOutput = '【委派简报】\n- 这是模型选择返回的用户可见正文';
  const model = {
    invoke: async () => {
      answerCallCount += 1;
      return new AIMessage(modelOutput);
    },
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
    withStructuredOutput: () => ({
      invoke: async () => ({ action: 'unavailable', tasks: [] }),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: model,
      decision: new FakeListChatModel({ responses: ['直接回答当前请求。'], sleep: 0 }),
      observe: model,
    },
    actor: testActor,
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('直接回答。'),
  ]), {
    configurable: { thread_id: 'answer-briefing-safe-fallback', actor: testActor },
  }) as OrchestratorStateType;

  assert.equal(answerCallCount, 1);
  assert.equal(state.messages.at(-1)?.content, modelOutput);
});

test('limit-reached progress announce lets model choose the same capability delegation', async () => {
  let capabilityRunCount = 0;
  let plannerCallCount = 0;
  let plannerInput: CapabilityPlannerInput | null = null;
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      // delegation_outcome keeps using the active capability lane as its
      // continuation candidate; no run-entry search is needed here.
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({ invoke: async () => goalDoneDecision() }),
  } as unknown as AgentModels['act'];
  const inspectCapability: AgentCapability = {
    name: 'inspect_repo',
    description: 'Inspect repository.',
    uses: [],
    instructions: defineInstructionDocument({
      content: 'Inspect the repository.',
    }),
    lifecycle: {
      finalize: () => {
        capabilityRunCount += 1;
      },
    },
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    maxRunIterations: 1,
    actor: testActor,
    capabilityPlannerRunner: {
      async invoke(input) {
        plannerCallCount += 1;
        plannerInput = input;
        return {
          action: 'continue_current',
          tasks: [],
        };
      },
    },
  });
  const input = {
    ...buildOrchestratorRunInput([
      new HumanMessage('先调查仓库，再修复注册链路。'),
      new AIMessage('先从仓库调查开始。'),
      new HumanMessage('继续'),
    ], { activeDelegationTransition: 'resume_active' }),
    taskActiveDelegation: null as TaskActiveDelegation | null,
  };
  const progressAnnounce = createPrivateAnnounce({
    lane: 'capability:inspect_repo',
    runId: input.runId,
    completionReason: 'limit_reached',
    delegationId: 'task-limit',
    task: '调查仓库 capability 注册链路。',
    result: '(no matches)',
  });
  input.messages.push(progressAnnounce);
  input.runDelegationSummaries = [{
    id: 'task-limit',
    lane: 'capability:inspect_repo',
    task: '调查仓库 capability 注册链路。',
    status: 'progress',
    resultPreview: '(no matches)',
  }];
  input.taskActiveDelegation = {
    id: 'task-limit',
    lane: 'capability:inspect_repo',
    task: '调查仓库 capability 注册链路。',
    contextSummary: null,
    runId: input.runId,
    traceId: input.traceId,
    status: 'awaiting_decision',
    resultPreview: '(no matches)',
    userRequest: '先调查仓库，再修复注册链路。',
  };

  await graph.invoke(input, {
    configurable: {
      thread_id: 'limit-progress-auto-resume',
      actor: testActor,
      capabilities: [inspectCapability],
      toolkits: [],
    },
  });

  assert.equal(capabilityRunCount, 1);
  assert.equal(plannerCallCount, 1);
  const observedPlannerInput = plannerInput as CapabilityPlannerInput | null;
  assert.equal(observedPlannerInput?.activeDelegation?.capability, 'inspect_repo');
  assert.equal(observedPlannerInput?.latestAnnounce?.completionReason, 'limit_reached');
  assert.match(plannerMessageContextText(observedPlannerInput), /继续/);
});

test('toolkits compose tools and instructions for capability runtimes', async () => {
  const browserOpen = mockTool('browser_open');
  const readFile = mockTool('read_file');
  const toolkits: AgentToolkit[] = [
    {
      name: 'browser',
      description: 'browser toolkit',
      tools: toolDefinitions(browserOpen),
      instructions: 'browser rules',
    },
    {
      name: 'bash',
      description: 'bash toolkit',
      tools: toolDefinitions(readFile),
      instructions: 'bash rules',
    },
  ];

  const browserExecution = await resolveToolkitExecution(toolkits, ['browser'], {
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
  });
  const allExecution = await resolveToolkitExecution(toolkits, undefined, {
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
  });

  assert.deepEqual(browserExecution.tools.map((toolItem) => toolItem.name), ['browser_open']);
  assert.equal(browserExecution.toolkits[0]?.instructions, 'browser rules');
  assert.deepEqual(allExecution.tools.map((toolItem) => toolItem.name), ['browser_open', 'read_file']);

});

test('tools requiring an input modality bind only to model profiles that accept it', async () => {
  const readText = mockTool('read_text');
  const readImage = mockTool('read_image');
  const toolkits: AgentToolkit[] = [{
    name: 'inspect',
    description: 'inspection toolkit',
    tools: [
      { tool: readText },
      { tool: readImage, requiresInputModalities: ['image'] },
    ],
  }];
  const resolve = (modelInputModalities?: readonly ModelInputModality[]) =>
    resolveToolkitExecution(toolkits, undefined, {
      models: {} as AgentModels,
      ...(modelInputModalities ? { modelInputModalities } : {}),
      actor: testActor,
      messages: [],
    });

  assert.deepEqual(
    (await resolve(['text'])).tools.map((toolItem) => toolItem.name),
    ['read_text'],
  );
  assert.deepEqual(
    (await resolve(['text', 'image'])).tools.map((toolItem) => toolItem.name),
    ['read_text', 'read_image'],
  );
  // An unstated profile is text-only, so the image tool stays unbound rather
  // than reaching a model that cannot read its result.
  assert.deepEqual(
    (await resolve()).tools.map((toolItem) => toolItem.name),
    ['read_text'],
  );
});

test('capability receives tools only from Toolkits authorized by fixed uses', async () => {
  let routeCallCount = 0;
  let capabilityToolNames: string[] = [];
  let capabilityTools: Array<{ name: string }> = [];
  const runtimeEvents: string[] = [];
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        if (routeCallCount === 1) {
          return scriptedPlannerTask('inspect repository');
        }
        if (routeCallCount === 2) {
          return scriptedPlannerCapability('inspect_repo');
        }
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeToolCallingModel({ toolCalls: [[]] });
  const bindTools = subagentModel.bindTools.bind(subagentModel);
  (subagentModel as unknown as {
    bindTools: (tools: Array<{ name: string }>) => unknown;
  }).bindTools = (tools) => {
    capabilityToolNames = tools.map((toolItem) => toolItem.name);
    capabilityTools = tools;
    return bindTools(tools as never);
  };
  const staticReadFile = mockTool('read_file');
  const boundReadFile = mockTool('read_file');
  const toolkitRuntimeManager = new ToolkitRuntimeManager();
  const runtimeCapability: AgentCapability = {
    name: 'inspect_repo',
    description: 'Inspect repository with bash tools.',
    uses: ['bash'],
    instructions: defineInstructionDocument({
      content: 'Inspect the repository with the authorized tools.',
    }),
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: subagentModel,
    },
    actor: testActor,
    toolkitRuntimeManager,
  });

  await graph.invoke(buildOrchestratorRunInput([new HumanMessage('inspect')]), {
    configurable: {
      thread_id: 'available-toolkits-runtime',
      actor: testActor,
      capabilities: [runtimeCapability],
      toolkits: [
        {
          name: 'bash',
          description: 'bash toolkit',
          tools: toolDefinitions(staticReadFile),
          runtime: {
            start: () => {
              runtimeEvents.push('start');
              return { host: 'local' };
            },
            resolve: (_root: unknown, context: ToolkitRuntimeResolveContext) => {
              runtimeEvents.push(`resolve:${context.execution.delegationId}`);
              return { host: 'local' };
            },
            bindTools: () => [boundReadFile],
            release: () => {
              runtimeEvents.push('release');
            },
          },
        },
        {
          name: 'browser',
          description: 'browser toolkit',
          tools: toolDefinitions(mockTool('browser_open')),
        },
        {
          name: 'artifact',
          description: 'artifact toolkit',
          tools: toolDefinitions(mockTool('artifact_read')),
        },
      ],
      allowedCapabilityNames: ['inspect_repo'],
    },
  });

  assert.deepEqual(capabilityToolNames, ['read_file']);
  assert.notEqual(capabilityTools[0], staticReadFile);
  assert.notEqual(capabilityTools[0], boundReadFile);
  assert.equal(
    (capabilityTools[0] as StructuredTool | undefined)?.schema,
    staticReadFile.schema,
  );
  assert.equal(runtimeEvents[0], 'start');
  assert.match(runtimeEvents[1] ?? '', /^resolve:/);
  assert.equal(runtimeEvents[2], 'release');
  await toolkitRuntimeManager.stop();
});

test('capability tools receive their Toolkit Runtime port with invocation identity', async () => {
  let routeCallCount = 0;
  let seenRuntime: unknown;
  let seenExecutionScope: SubagentRuntimeContext['executionScope'];
  const browserRuntime = Object.freeze({ kind: 'browser-runtime' });
  const inspectRuntime = tool(async (
    _input,
    runtime: ToolRuntime<unknown, SubagentRuntimeContext>,
  ) => {
    seenRuntime = runtime.context.toolkitRuntimes?.browser;
    seenExecutionScope = runtime.context.executionScope;
    return 'runtime inspected';
  }, {
    name: 'browser_snapshot',
    description: 'Inspect the active browser runtime.',
    schema: z.object({}),
  });
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        if (routeCallCount === 1) return scriptedPlannerTask('inspect browser state');
        if (routeCallCount === 2) return scriptedPlannerCapability('inspect_browser');
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeToolCallingModel({
    toolCalls: [
      [{ id: 'inspect-browser-runtime', name: 'browser_snapshot', args: {} }],
      [],
    ],
  });
  const toolkitRuntimeManager = new ToolkitRuntimeManager();
  const graph = createOrchestratorGraph({
    models: { act: routeModel, observe: routeModel, subagent: subagentModel },
    actor: testActor,
    toolkitRuntimeManager,
  });

  await graph.invoke(buildOrchestratorRunInput([new HumanMessage('inspect')]), {
    configurable: {
      thread_id: 'browser-runtime-context',
      workdir: '/workspace',
      actor: testActor,
      capabilities: [{
        name: 'inspect_browser',
        description: 'Inspect browser state.',
        uses: ['browser'],
        instructions: defineInstructionDocument({
          content: 'Inspect the browser with the authorized tools.',
        }),
      }],
      toolkits: [{
        name: 'browser',
        description: 'browser toolkit',
        tools: toolDefinitions(inspectRuntime),
        runtime: {
          start: () => browserRuntime,
        },
      }],
      allowedCapabilityNames: ['inspect_browser'],
    },
  });

  assert.equal(seenRuntime, browserRuntime);
  assert.equal(seenExecutionScope?.threadId, 'browser-runtime-context');
  assert.equal(seenExecutionScope?.workdir, '/workspace');
  assert.ok(seenExecutionScope?.runId);
  assert.ok(seenExecutionScope?.delegationId);
  await toolkitRuntimeManager.stop();
});

test('artifact discovery tools reach a selected capability only when declared in uses', async () => {
  let decisionCallCount = 0;
  let capabilityToolNames: string[] = [];
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
    withStructuredOutput: () => ({
      invoke: async () => {
        decisionCallCount += 1;
        if (decisionCallCount === 1) return scriptedPlannerTask('inspect browser state');
        if (decisionCallCount === 2) return scriptedPlannerCapability('browser_like');
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeToolCallingModel({ toolCalls: [[]] });
  const bindTools = subagentModel.bindTools.bind(subagentModel);
  (subagentModel as unknown as {
    bindTools: (tools: Array<{ name: string }>) => unknown;
  }).bindTools = (tools) => {
    capabilityToolNames = tools.map((toolItem) => toolItem.name);
    return bindTools(tools as never);
  };
  const graph = createOrchestratorGraph({
    models: { act: routeModel, observe: routeModel, subagent: subagentModel },
    actor: testActor,
  });

  await graph.invoke(buildOrchestratorRunInput([new HumanMessage('inspect')]), {
    configurable: {
      thread_id: 'capability-artifact-discovery-tools',
      actor: testActor,
      capabilities: [{
        name: 'browser_like',
        description: 'browser-only capability',
        uses: ['browser', 'artifact_discovery'],
        instructions: defineInstructionDocument({
          content: 'Inspect browser state and related artifacts.',
        }),
      }],
      toolkits: [
        {
          name: 'browser',
          description: 'browser toolkit',
          tools: toolDefinitions(mockTool('browser_open')),
        },
        {
          name: 'artifact_discovery',
          description: 'artifact discovery toolkit',
          tools: toolDefinitions(
            mockTool('artifact_list'),
            mockTool('artifact_read'),
          ),
        },
      ],
      allowedCapabilityNames: ['browser_like'],
    },
  });

  assert.deepEqual(capabilityToolNames, [
    'browser_open',
    'artifact_list',
    'artifact_read',
  ]);
});

test('general Capability composes its declared Toolkits', async () => {
  let routeCallCount = 0;
  let generalToolNames: string[] = [];
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        if (routeCallCount === 1) {
          return scriptedPlannerTask('inspect workspace and prior artifacts');
        }
        if (routeCallCount === 2) {
          return scriptedPlannerCapability('general');
        }
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeToolCallingModel({ toolCalls: [[]] });
  const bindTools = subagentModel.bindTools.bind(subagentModel);
  (subagentModel as unknown as {
    bindTools: (tools: Array<{ name: string }>) => unknown;
  }).bindTools = (tools) => {
    generalToolNames = tools.map((toolItem) => toolItem.name);
    return bindTools(tools as never);
  };
  const recorder = createSubagentInputRecorder();
  const graph = createOrchestratorGraph({
    models: { act: routeModel, observe: routeModel, subagent: subagentModel },
    actor: testActor,
  });

  await graph.invoke(buildOrchestratorRunInput([new HumanMessage('inspect')]), {
    configurable: {
      thread_id: 'general-artifact-discovery-tools',
      actor: testActor,
      capabilities: [
        capability('general', 'General-purpose capability.', ['bash', 'artifact_discovery']),
      ],
      toolkits: [
        {
          name: 'bash',
          description: 'workspace file tools',
          tools: toolDefinitions(mockTool('list_dir'), mockTool('view_file_chunk')),
        },
        {
          name: 'artifact_discovery',
          description: 'artifact discovery toolkit',
          tools: toolDefinitions(
            mockTool('artifact_list'),
            mockTool('artifact_read'),
          ),
        },
      ],
    },
    callbacks: recorder.callbacks,
  });

  assert.deepEqual(generalToolNames, [
    'list_dir',
    'view_file_chunk',
    'artifact_list',
    'artifact_read',
  ]);
  assert.equal(recorder.subagentInputs.length, 1);
  assert.doesNotMatch(
    JSON.stringify(recorder.subagentInputs[0].map((message) => message.content)),
    /小白|物种：cat|性格：友好/,
  );
});

test('toolkit registration does not rely on lane authorization flags', async () => {
  let routeCallCount = 0;
  let generalToolNames: string[] = [];
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        if (routeCallCount === 1) {
          return scriptedPlannerTask('inspect with tools');
        }
        if (routeCallCount === 2) {
          return scriptedPlannerCapability('general');
        }
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeToolCallingModel({ toolCalls: [[]] });
  const bindTools = subagentModel.bindTools.bind(subagentModel);
  (subagentModel as unknown as {
    bindTools: (tools: Array<{ name: string }>) => unknown;
  }).bindTools = (tools) => {
    generalToolNames = tools.map((toolItem) => toolItem.name);
    return bindTools(tools as never);
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: subagentModel,
    },
    actor: testActor,
  });

  await graph.invoke(buildOrchestratorRunInput([new HumanMessage('inspect')]), {
    configurable: {
      thread_id: 'general-toolkit-registration',
      actor: testActor,
      capabilities: [
        capability('general', 'General-purpose capability.', ['visible', 'artifact']),
      ],
      toolkits: [
        {
          name: 'visible',
          description: 'visible toolkit',
          tools: toolDefinitions(mockTool('visible_tool')),
        },
        {
          name: 'artifact',
          description: 'artifact toolkit',
          tools: toolDefinitions(mockTool('artifact_read')),
        },
      ],
    },
  });

  assert.deepEqual(generalToolNames, ['visible_tool', 'artifact_read']);
});

test('toolkit ToolDefinition operations are collected with their source', () => {
  const toolkits: AgentToolkit[] = [{
    name: 'bash',
    description: 'bash toolkit',
    tools: [
      {
        tool: mockTool('read_file'),
        operation: {
          title: 'Read File',
        },
      },
      {
        tool: mockTool('shared_tool'),
        operation: {},
      },
    ],
  }];

  const toolkitOperations = collectToolkitOperations(toolkits);
  assert.equal(toolkitOperations.read_file?.title, 'Read File');
  assert.deepEqual(toolkitOperations.read_file?.source, {
    provider: 'toolkit',
    name: 'bash',
    toolName: 'read_file',
  });

  assert.deepEqual(toolkitOperations.shared_tool?.source, {
    provider: 'toolkit',
    name: 'bash',
    toolName: 'shared_tool',
  });
});

test('executor operations are collected from toolkits', () => {
  const generalOperations = collectToolkitOperations([{
    name: 'bash',
    description: 'bash toolkit',
    tools: [{
      tool: mockTool('read_file'),
      operation: {},
    }],
  }]);

  assert.deepEqual(generalOperations.read_file?.source, {
    provider: 'toolkit',
    name: 'bash',
    toolName: 'read_file',
  });
});

test('capability finalize artifact refs are merged into state', async () => {
  let routeCallCount = 0;
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        if (routeCallCount === 1) {
          return scriptedPlannerTask('inspect issue context');
        }
        if (routeCallCount === 2) {
          return scriptedPlannerCapability('explore');
        }
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const persistReportTool = tool(async () => 'persisted', {
    name: 'persist_report',
    description: 'persist report',
    schema: z.object({}),
  });
  const artifactToolkit: AgentToolkit = {
    name: 'artifact',
    description: 'artifact recorder',
    tools: toolDefinitions(persistReportTool),
  };
  const fixtureCapability: AgentCapability = {
    name: 'explore',
    description: 'Explore issue context.',
    uses: ['artifact'],
    instructions: defineInstructionDocument({
      content: 'Explore issue context.',
    }),
    lifecycle: {
      finalize: async (_result, ctx) => {
        const ref = {
          id: 'artifact-1',
          threadId: ctx.threadId ?? 'missing-thread',
          capabilityId: ctx.capabilityId,
          delegationId: ctx.delegationId,
          runId: ctx.runId,
          kind: 'report' as const,
          mimeType: 'text/markdown',
          uri: `capability-artifact://thread/${encodeURIComponent(ctx.threadId ?? '')}/artifact/1`,
          title: 'Issue exploration',
          preview: 'Checked the artifact handoff path.',
          sizeBytes: 19,
          createdAt: '2026-06-16T00:00:00.000Z',
          schema: { name: 'ExploreReport', version: 1 },
          metadata: { sourceCount: 2 },
        };
        await ctx.recordCapabilityArtifact?.(ref);
        return { artifactRefs: [ref] };
      },
    },
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeToolCallingModel({
        toolCalls: [[{ id: 'call-persist', name: 'persist_report', args: {} }], []],
      }),
    },
    actor: testActor,
  });

  const state = await graph.invoke(buildOrchestratorRunInput([new HumanMessage('explore issue')]), {
    configurable: {
      thread_id: 'artifact-thread',
      actor: testActor,
      capabilities: [fixtureCapability],
      toolkits: [artifactToolkit],
      allowedCapabilityNames: ['explore'],
    },
  });

  assert.equal(state.sessionCapabilityArtifacts.length, 1);
  assert.equal(state.sessionCapabilityArtifacts[0]?.title, 'Issue exploration');
  assert.equal(state.sessionCapabilityArtifacts[0]?.threadId, 'artifact-thread');
  assert.equal(state.sessionCapabilityArtifacts[0]?.capabilityId, 'explore');
});

test('capability finalize stores only artifact refs in state', async () => {
  let routeCallCount = 0;
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        if (routeCallCount === 1) {
          return scriptedPlannerTask('create post');
        }
        if (routeCallCount === 2) {
          return scriptedPlannerCapability('content_writer');
        }
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const persistResultTool = tool(async () => 'persisted', {
    name: 'persist_result',
    description: 'persist result',
    schema: z.object({}),
  });
  const artifactToolkit: AgentToolkit = {
    name: 'artifact',
    description: 'artifact recorder',
    tools: toolDefinitions(persistResultTool),
  };
  const fixtureCapability: AgentCapability = {
    name: 'content_writer',
    description: 'Create post.',
    uses: ['artifact'],
    instructions: defineInstructionDocument({
      content: 'Create a post.',
    }),
    lifecycle: {
      finalize: async (_result, ctx) => {
        const ref = {
          id: 'result-1',
          threadId: ctx.threadId ?? 'missing-thread',
          capabilityId: ctx.capabilityId,
          delegationId: ctx.delegationId,
          runId: ctx.runId,
          kind: 'result' as const,
          mimeType: 'application/json',
          uri: `capability-artifact://thread/${encodeURIComponent(ctx.threadId ?? '')}/artifact/result-1`,
          title: 'Content writer result',
          preview: 'created post-1',
          sizeBytes: 39,
          createdAt: '2026-06-16T00:00:00.000Z',
          schema: { name: 'content_writer.result', version: 1 },
        };
        await ctx.recordCapabilityArtifact?.(ref);
        return { artifactRefs: [ref] };
      },
    },
  };
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeToolCallingModel({
        toolCalls: [[{ id: 'call-persist', name: 'persist_result', args: {} }], []],
      }),
    },
    actor: testActor,
  });

  const state = await graph.invoke(buildOrchestratorRunInput([new HumanMessage('post')]), {
    configurable: {
      thread_id: 'result-artifact-thread',
      actor: testActor,
      capabilities: [fixtureCapability],
      toolkits: [artifactToolkit],
      allowedCapabilityNames: ['content_writer'],
    },
  });

  assert.equal(state.sessionCapabilityArtifacts[0]?.kind, 'result');
  assert.equal(state.sessionCapabilityArtifacts[0]?.schema?.name, 'content_writer.result');
});

test('runAgent reuses a host-precompiled artifact discovery registry', async () => {
  const calls: Array<{
    input?: { traceId?: string; runId?: string };
    configurable?: Record<string, unknown>;
  }> = [];
  const graph = {
    invoke: async (
      graphInput: { traceId?: string; runId?: string },
      options?: { configurable?: Record<string, unknown> },
    ) => {
      calls.push({ input: graphInput, configurable: options?.configurable });
      return { messages: [new AIMessage('done')] };
    },
  };

  const artifactDiscoveryToolkit: AgentToolkit = {
    name: 'artifact_discovery',
    description: 'artifact discovery toolkit',
    tools: toolDefinitions(
      mockTool('artifact_list'),
      mockTool('artifact_read'),
    ),
  };
  const preparedRegistry = compileAgentRegistry({
    toolkits: [artifactDiscoveryToolkit],
    capabilities: [
      capability(
        'general',
        'General-purpose capability.',
        ['artifact_discovery'],
      ),
    ],
  });
  const result = await runAgent(graph as never, {
    messages: [new HumanMessage('hello')],
    traceId: 'host-task-trace',
    toolkits: [artifactDiscoveryToolkit],
    capabilities: [
      capability(
        'general',
        'General-purpose capability.',
        ['artifact_discovery'],
      ),
    ],
  }, {
    registry: preparedRegistry,
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: true,
    },
  });

  assert.equal(result.reply, 'done');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input?.traceId, 'host-task-trace');
  assert.ok(calls[0]?.input?.runId);
  const registry = calls[0]?.configurable?.registry as {
    toolkits?: AgentToolkit[];
    capabilities?: Array<{
      capability: AgentCapability;
      toolkits: AgentToolkit[];
    }>;
  };
  assert.equal(registry, preparedRegistry);
  assert.deepEqual(calls[0]?.configurable?.reviewCapabilities, {
    humanReview: false,
    sessionAuthorization: true,
  });
  assert.deepEqual(registry.toolkits?.map(({ name }) => name), ['artifact_discovery']);
  assert.deepEqual(
    registry.capabilities?.find(
      ({ capability: item }) => item.name === 'general',
    )?.toolkits.map(({ name }) => name),
    ['artifact_discovery'],
  );
  assert.equal(calls[0]?.configurable?.artifactDiscoveryRoot, undefined);
  assert.equal(calls[0]?.configurable?.artifactDiscoveryToolkit, undefined);
});

test('capability Toolkit exposes ToolDefinition operation metadata', () => {
  const saveDraftTool = tool(async () => 'ok', {
    name: 'save_draft',
    description: 'save a draft',
    schema: z.object({
      topic: z.string(),
      content: z.string(),
    }),
  });
  const draftToolkit: AgentToolkit = {
    name: 'draft_writer',
    description: 'Draft writer tools.',
    tools: [{
      tool: saveDraftTool,
      operation: {
        title: '保存草稿',
        summarizeInput: (input) => {
          const value = input && typeof input === 'object'
            ? input as { topic?: unknown; content?: unknown }
            : {};
          return {
            target: typeof value.topic === 'string' ? value.topic : undefined,
            summary: '保存草稿',
            details: {
              contentLength: typeof value.content === 'string' ? value.content.length : undefined,
            },
          };
        },
      },
    }],
  };

  const definition = draftToolkit.tools[0];
  assert.equal(definition?.operation?.title, '保存草稿');
  assert.deepEqual(collectToolkitOperations([draftToolkit]).save_draft?.source, {
    provider: 'toolkit',
    name: 'draft_writer',
    toolName: 'save_draft',
  });

  const summary = definition?.operation?.summarizeInput?.({
    content: '这是一段待发布的正文',
    topic: '早餐',
  });
  assert.equal(summary?.target, '早餐');
  assert.equal(summary?.summary, '保存草稿');
  assert.deepEqual(summary?.details, {
    contentLength: '这是一段待发布的正文'.length,
  });
  assert.equal(JSON.stringify(summary).includes('这是一段待发布的正文'), false);
});

test('toolkit review policy runs after model without changing tool identity', async () => {
  let callCount = 0;
  let reviewCount = 0;
  let reviewContextKeys: string[] = [];
  const order: string[] = [];
  const rawTool = tool(async () => {
    order.push('tool');
    callCount += 1;
    return 'raw ok';
  }, {
    name: 'safe_tool',
    description: 'safe tool',
    schema: z.object({}),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'guarded',
    description: 'guarded toolkit',
    tools: [reviewedTool(rawTool, {
      request: (ctx) => {
        reviewContextKeys = Object.keys(ctx).sort();
        order.push('review');
        reviewCount += 1;
        return null;
      },
    })],
  }];

  const resources = await resolveToolkitExecution(toolkits, ['guarded'], {
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
  });

  assert.equal(resources.tools[0]?.name, 'safe_tool');
  assert.equal(resources.tools[0]?.description, 'safe tool');
  assert.equal(resources.tools[0], rawTool);
  assert.equal(resources.middleware.length, 1);

  const result = await runToolkitToolCall(resources, {
    id: 'call-safe',
    name: 'safe_tool',
    args: {},
  });
  assert.equal(reviewCount, 1);
  assert.equal(callCount, 1);
  assert.deepEqual(order, ['review', 'tool']);
  assert.deepEqual(reviewContextKeys, [
    'authorizationMatcher',
    'input',
    'operation',
    'reviewCapabilities',
    'toolName',
    'toolkitName',
  ]);
  assert.equal(readToolMessageContent(result.messages, 'call-safe'), 'raw ok');
});

test('toolkit review cancellation stops the current review action', async () => {
  let allowedCallCount = 0;
  let blockedCallCount = 0;
  let allowedReviewCount = 0;
  let laterCallCount = 0;
  let laterReviewCount = 0;
  const allowedTool = tool(async () => {
    allowedCallCount += 1;
    return 'allowed ok';
  }, {
    name: 'allowed_tool',
    description: 'allowed tool',
    schema: z.object({}),
  });
  const blockedTool = tool(async () => {
    blockedCallCount += 1;
    return 'blocked should not run';
  }, {
    name: 'blocked_tool',
    description: 'blocked tool',
    schema: z.object({}),
  });
  const laterTool = tool(async () => {
    laterCallCount += 1;
    return 'later ok';
  }, {
    name: 'later_tool',
    description: 'later tool',
    schema: z.object({}),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'guarded',
    description: 'guarded toolkit',
    tools: [
      reviewedTool(allowedTool, {
        request: () => {
          allowedReviewCount += 1;
          return null;
        },
      }),
      reviewedTool(blockedTool, {
          request: () => ({
            type: 'block',
            reason: 'blocked by policy',
          }),
      }),
      reviewedTool(laterTool, {
        request: () => {
          laterReviewCount += 1;
          return null;
        },
      }),
    ],
  }];

  const resources = await resolveToolkitExecution(toolkits, ['guarded'], {
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
  });
  const result = await runToolkitToolCall(resources, [
    { id: 'call-allowed', name: 'allowed_tool', args: {} },
    { id: 'call-blocked', name: 'blocked_tool', args: {} },
    { id: 'call-later', name: 'later_tool', args: {} },
  ]);

  const allowedResult = JSON.parse(String(readToolMessageContent(
    result.messages,
    'call-allowed',
  ))) as { cancelled?: boolean; reason?: string; skipped?: boolean };
  const blockedResult = JSON.parse(String(readToolMessageContent(
    result.messages,
    'call-blocked',
  ))) as { cancelled?: boolean; reason?: string; skipped?: boolean };
  const laterResult = JSON.parse(String(readToolMessageContent(
    result.messages,
    'call-later',
  ))) as { cancelled?: boolean; reason?: string; skipped?: boolean };
  assert.equal(allowedResult.cancelled, true);
  assert.equal(allowedResult.skipped, true);
  assert.match(allowedResult.reason ?? '', /another tool call in this review action was cancelled/);
  assert.equal(blockedResult.cancelled, true);
  assert.equal(blockedResult.skipped, undefined);
  assert.match(blockedResult.reason ?? '', /blocked by policy/);
  assert.equal(laterResult.cancelled, true);
  assert.equal(laterResult.skipped, true);
  assert.match(laterResult.reason ?? '', /another tool call in this review action was cancelled/);
  assert.equal(blockedCallCount, 0);
  assert.equal(allowedCallCount, 0);
  assert.equal(allowedReviewCount, 1);
  assert.equal(laterCallCount, 0);
  assert.equal(laterReviewCount, 0);
});

test('deterministic toolkit policy block terminates without another model call', async () => {
  let blockedCallCount = 0;
  const blockedTool = tool(async () => {
    blockedCallCount += 1;
    return 'blocked should not run';
  }, {
    name: 'blocked_tool',
    description: 'blocked tool',
    schema: z.object({}),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'guarded',
    description: 'guarded toolkit',
    tools: [reviewedTool(blockedTool, {
      request: () => ({
        type: 'block',
        reason: 'blocked by policy',
      }),
    })],
  }];

  const resources = await resolveToolkitExecution(toolkits, ['guarded'], {
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
  });
  const recorder = createSubagentInputRecorder();
  const result = await createSubagent({
    model: new FakeToolCallingModel({
      toolCalls: [
        [{ id: 'call-blocked', name: 'blocked_tool', args: {} }],
        [],
      ],
    }),
    tools: resources.tools,
    middleware: resources.middleware,
    promptSections: [],
    operations: collectToolkitOperations(resources.toolkits),
    messages: [new HumanMessage('try guarded work')],
    runnableConfig: { callbacks: recorder.callbacks },
  });

  assert.equal(blockedCallCount, 0);
  const blockedResult = JSON.parse(String(
    readToolMessageContent(result.messages, 'call-blocked'),
  )) as { cancelled?: boolean; reason?: string };
  assert.equal(blockedResult.cancelled, true);
  assert.match(blockedResult.reason ?? '', /blocked by policy/);
  assert.equal(recorder.subagentInputs.length, 1);
  const lastMessage = result.messages.at(-1);
  assert.ok(AIMessage.isInstance(lastMessage));
  assert.match(String(lastMessage.content), /被策略阻止/);
  assert.equal(result.completionReason, 'natural');
});

test('toolkit review materializes distinct fallback ids for missing tool call ids', async () => {
  const blockedTool = tool(async () => 'blocked should not run', {
    name: 'blocked_tool',
    description: 'blocked tool',
    schema: z.object({ path: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'guarded',
    description: 'guarded toolkit',
    tools: [reviewedTool(blockedTool, {
          request: () => ({
            type: 'block',
            reason: 'blocked by policy',
          }),
    })],
  }];

  const resources = await resolveToolkitExecution(toolkits, ['guarded'], {
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
  });
  const result = await runToolkitToolCall(resources, [
    { name: 'blocked_tool', args: { path: 'a.txt' } },
    { name: 'blocked_tool', args: { path: 'b.txt' } },
  ]);

  const toolMessages = readToolMessages(result.messages);
  assert.equal(toolMessages.length, 2);
  assert.match(toolMessages[0]?.tool_call_id ?? '', /^pending_action:/);
  assert.match(toolMessages[1]?.tool_call_id ?? '', /^pending_action:/);
  assert.notEqual(toolMessages[0]?.tool_call_id, toolMessages[1]?.tool_call_id);
  const cancelledResults = toolMessages.map((message) => JSON.parse(String(message.content)) as {
    cancelled?: boolean;
    retryable?: boolean;
    guidance?: string;
  });
  assert.deepEqual(cancelledResults.map((item) => item.cancelled), [true, true]);
  assert.deepEqual(cancelledResults.map((item) => item.retryable), [false, false]);
  assert.match(cancelledResults[0]?.guidance ?? '', /blocked by policy/);

  const reviewedMessage = result.messages.find((message): message is AIMessage =>
    AIMessage.isInstance(message)
    && (message.tool_calls?.length ?? 0) === 2);
  assert.deepEqual(
    reviewedMessage?.tool_calls?.map((toolCall) => toolCall.id),
    toolMessages.map((message) => message.tool_call_id),
  );
});

test('global review policy full_access bypasses toolkit review prompts', async () => {
  let callCount = 0;
  let reviewCount = 0;
  const rawTool = tool(async () => {
    callCount += 1;
    return 'raw ok';
  }, {
    name: 'write_file',
    description: 'write file',
    schema: z.object({ path: z.string(), content: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [reviewedTool(rawTool, {
      request: () => {
        reviewCount += 1;
        return ReviewPolicies.localMutation().request({
              toolkitName: 'local',
              toolName: 'write_file',
              input: { path: 'notes.md', content: 'hello' },
              reviewCapabilities: {
                humanReview: true,
                sessionAuthorization: false,
              },
        });
      },
    })],
  }];

  const resources = await resolveToolkitExecution(toolkits, ['local'], {
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: false,
    },
    globalReviewPolicy: { mode: 'full_access' },
  });

  assert.equal(resources.middleware.length, 0);
  const result = await runToolkitToolCall(resources, {
    id: 'call-write',
    name: 'write_file',
    args: { path: 'notes.md', content: 'hello' },
  });
  assert.equal(readToolMessageContent(result.messages, 'call-write'), 'raw ok');
  assert.equal(callCount, 1);
  assert.equal(reviewCount, 0);
});

test('global review policy auto_authorization authorizes safe reviewed tool calls', async () => {
  let callCount = 0;
  let autoReviewCount = 0;
  let autoReviewMessages: unknown;
  const runtimeEvents: unknown[] = [];
  const rawTool = tool(async ({ path }: { path: string }) => {
    callCount += 1;
    return `wrote ${path}`;
  }, {
    name: 'write_file',
    description: 'write file',
    schema: z.object({ path: z.string(), content: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [reviewedTool(rawTool, ReviewPolicies.localMutation())],
  }];
  const autoModel = {
    withStructuredOutput: () => ({
      invoke: async (messages: unknown) => {
        autoReviewCount += 1;
        autoReviewMessages = messages;
        return {
          riskScore: 1,
          reason: 'Small scoped file write inside the workdir.',
        };
      },
    }),
  } as unknown as AgentModels['act'];

  const resources = await resolveToolkitExecution(toolkits, ['local'], {
    models: { act: autoModel },
    actor: testActor,
    messages: [new HumanMessage('subagent context')],
    reviewContext: {
      task: 'Write the requested notes file',
      workdir: '/repo',
    },
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: false,
    },
    globalReviewPolicy: { mode: 'auto_authorization' },
    emitRuntimeEvent: (event) => {
      runtimeEvents.push(event);
    },
  });

  const result = await runToolkitToolCall(resources, {
    id: 'call-auto-write',
    name: 'write_file',
    args: { path: 'notes.md', content: 'hello' },
  });
  assert.equal(readToolMessageContent(result.messages, 'call-auto-write'), 'wrote notes.md');
  assert.equal(callCount, 1);
  assert.equal(autoReviewCount, 1);
  const systemPrompt = (autoReviewMessages as Array<{ content?: unknown }>)[0]?.content;
  assert.match(String(systemPrompt), /untrusted evidence/);
  const reviewPrompt = String((autoReviewMessages as Array<{ content?: unknown }>)[1]?.content);
  assert.match(reviewPrompt, /<current_task role="context" authority="none">[\s\S]*Write the requested notes file/);
  assert.match(reviewPrompt, /<workdir authority="runtime">[\s\S]*\/repo/);
  assert.doesNotMatch(reviewPrompt, /subagent context/);
  assert.doesNotMatch(reviewPrompt, /user_requests|derived_task/);
  assert.doesNotMatch(reviewPrompt, /Decision policy:/);
  assert.doesNotMatch(reviewPrompt, /Test actor/);
  assert.equal((runtimeEvents[0] as { name?: unknown } | undefined)?.name, 'global_review_policy_auto_authorized');
});

test('global auto policy bypasses the model only for a deterministic complete batch', async () => {
  let callCount = 0;
  let autoReviewCount = 0;
  const sessionAuthorizations: ToolAuthorizationRecord[] = [];
  const runtimeEvents: unknown[] = [];
  const rawTool = tool(async ({ path }: { path: string }) => {
    callCount += 1;
    return `patched ${path}`;
  }, {
    name: 'apply_patch',
    description: 'patch file',
    schema: z.object({ path: z.string(), patch: z.string() }),
  });
  const otherTool = tool(async () => 'other action ran', {
    name: 'other_mutation',
    description: 'another mutation',
    schema: z.object({}),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [
      reviewedTool(rawTool, ReviewPolicies.localMutation({
        authorization: {
          authorize: ({ input, workdir }) => (
            workdir === '/repo'
            && (input as { path?: unknown }).path === 'notes.md'
          ),
        },
      })),
      reviewedTool(otherTool, ReviewPolicies.localMutation()),
    ],
  }];
  const autoModel = {
    withStructuredOutput: () => ({
      invoke: async () => {
        autoReviewCount += 1;
        return {
          riskScore: 10,
          reason: 'The model should not be called for this deterministic batch.',
        };
      },
    }),
  } as unknown as AgentModels['act'];

  const resources = await resolveToolkitExecution(toolkits, ['local'], {
    models: { act: autoModel },
    actor: testActor,
    messages: [],
    reviewContext: {
      task: 'Patch notes',
      workdir: '/repo',
    },
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: true,
    },
    globalReviewPolicy: { mode: 'auto_authorization' },
    toolAuthorizations: sessionAuthorizations,
    recordToolAuthorizations: (authorizations) => {
      sessionAuthorizations.push(...authorizations);
    },
    emitRuntimeEvent: (event) => {
      runtimeEvents.push(event);
    },
  });

  const result = await runToolkitToolCall(resources, {
    id: 'call-auto-patch',
    name: 'apply_patch',
    args: { path: 'notes.md', patch: 'change' },
  });
  assert.equal(readToolMessageContent(result.messages, 'call-auto-patch'), 'patched notes.md');
  assert.equal(callCount, 1);
  assert.equal(autoReviewCount, 0);
  assert.deepEqual(sessionAuthorizations, []);
  assert.equal((runtimeEvents[0] as { name?: unknown } | undefined)?.name, 'global_review_policy_auto_authorized');

  await runToolkitToolCall(resources, [{
    id: 'call-mixed-patch',
    name: 'apply_patch',
    args: { path: 'notes.md', patch: 'another change' },
  }, {
    id: 'call-other-mutation',
    name: 'other_mutation',
    args: {},
  }]);
  assert.equal(callCount, 1);
  assert.equal(autoReviewCount, 1);
});

test('global review policy reuses an exact auto authorization in the same session', async () => {
  let callCount = 0;
  let autoReviewCount = 0;
  const sessionAuthorizations: ToolAuthorizationRecord[] = [];
  const runtimeEvents: unknown[] = [];
  const rawTool = tool(async ({ command }: { command: string }) => {
    callCount += 1;
    return `ran ${command}`;
  }, {
    name: 'run_shell',
    description: 'run shell',
    schema: z.object({ command: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'bash',
    description: 'bash tools',
    tools: [reviewedTool(
      rawTool,
      ReviewPolicies.commandExecution({ authorization: 'exact' }),
    )],
  }];
  const autoModel = {
    withStructuredOutput: () => ({
      invoke: async () => {
        autoReviewCount += 1;
        return {
          riskScore: 1,
          reason: 'The exact command is a scoped read-only repository inspection.',
        };
      },
    }),
  } as unknown as AgentModels['act'];

  const resources = await resolveToolkitExecution(toolkits, ['bash'], {
    models: { act: autoModel },
    actor: testActor,
    messages: [],
    reviewContext: {
      task: 'Inspect repository state',
      workdir: '/repo',
    },
    reviewCapabilities: {
      humanReview: true,
      sessionAuthorization: true,
    },
    globalReviewPolicy: { mode: 'auto_authorization' },
    toolAuthorizations: sessionAuthorizations,
    recordToolAuthorizations: (authorizations) => {
      sessionAuthorizations.push(...authorizations);
    },
    emitRuntimeEvent: (event) => {
      runtimeEvents.push(event);
    },
  });

  const first = await runToolkitToolCall(resources, {
    id: 'call-status-1',
    name: 'run_shell',
    args: { command: 'git status --short' },
  });
  const second = await runToolkitToolCall(resources, {
    id: 'call-status-2',
    name: 'run_shell',
    args: { command: 'git status --short' },
  });
  const different = await runToolkitToolCall(resources, {
    id: 'call-diff',
    name: 'run_shell',
    args: { command: 'git diff --stat' },
  });

  assert.equal(readToolMessageContent(first.messages, 'call-status-1'), 'ran git status --short');
  assert.equal(readToolMessageContent(second.messages, 'call-status-2'), 'ran git status --short');
  assert.equal(readToolMessageContent(different.messages, 'call-diff'), 'ran git diff --stat');
  assert.equal(callCount, 3);
  assert.equal(autoReviewCount, 2);
  assert.deepEqual(
    sessionAuthorizations.map(({ createdAt: _createdAt, ...authorization }) => authorization),
    [
      {
        toolName: 'run_shell',
        source: 'auto_review',
        matcher: exactAuthorization({ command: 'git status --short' }),
      },
      {
        toolName: 'run_shell',
        source: 'auto_review',
        matcher: exactAuthorization({ command: 'git diff --stat' }),
      },
    ],
  );
  const runtimeEventNames = runtimeEvents.map((event) =>
    (event as { name?: unknown }).name);
  assert.equal(
    runtimeEventNames.filter((name) => name === 'global_review_policy_auto_authorized').length,
    2,
  );
  assert.equal(runtimeEventNames.filter((name) => name === 'tool_authorization_hit').length, 1);
  assert.equal(runtimeEventNames.filter((name) => name === 'tool_authorization_miss').length, 2);
  assert.equal(runtimeEventNames.filter((name) => name === 'tool_authorization_recorded').length, 2);

  sessionAuthorizations.push({
    toolName: 'run_shell',
    matcher: exactAuthorization({ command: 'git log -1' }),
    source: 'human',
    createdAt: '2026-07-31T00:00:00.000Z',
  });
  const downgradedResources = await resolveToolkitExecution(toolkits, ['bash'], {
    models: { act: autoModel },
    actor: testActor,
    messages: [],
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: true,
    },
    globalReviewPolicy: { mode: 'require_authorization' },
    toolAuthorizations: sessionAuthorizations,
  });
  const afterDowngrade = await runToolkitToolCall(downgradedResources, {
    id: 'call-status-after-downgrade',
    name: 'run_shell',
    args: { command: 'git status --short' },
  });
  const downgradeResult = JSON.parse(String(readToolMessageContent(
    afterDowngrade.messages,
    'call-status-after-downgrade',
  ))) as { cancelled?: boolean; source?: string };
  assert.equal(downgradeResult.cancelled, true);
  assert.equal(downgradeResult.source, 'policy_block');
  assert.equal(callCount, 3);
  assert.equal(autoReviewCount, 2);

  const humanAuthorized = await runToolkitToolCall(downgradedResources, {
    id: 'call-human-grant-after-downgrade',
    name: 'run_shell',
    args: { command: 'git log -1' },
  });
  assert.equal(
    readToolMessageContent(humanAuthorized.messages, 'call-human-grant-after-downgrade'),
    'ran git log -1',
  );
  assert.equal(callCount, 4);
});

test('exact auto authorization survives graph rebuild but expires on registry reload', async () => {
  let runCount = 0;
  let routeCallCount = 0;
  let autoReviewCount = 0;
  const rawTool = tool(async ({ command }: { command: string }) => {
    runCount += 1;
    return `ran ${command}`;
  }, {
    name: 'run_shell',
    description: 'run shell',
    schema: z.object({ command: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'bash',
    description: 'bash tools',
    tools: [reviewedTool(
      rawTool,
      ReviewPolicies.commandExecution({ authorization: 'exact' }),
    )],
  }];
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        const step = (routeCallCount - 1) % 3;
        if (step === 0) return scriptedPlannerTask('inspect repository');
        if (step === 1) return scriptedPlannerCapability('general');
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const autoReviewModel = {
    withStructuredOutput: () => ({
      invoke: async () => {
        autoReviewCount += 1;
        return {
          riskScore: 1,
          reason: 'The exact command is a scoped repository inspection.',
        };
      },
    }),
  } as unknown as AgentModels['observe'];
  const subagentModel = new FakeToolCallingModel({
    toolCalls: [
      [{
        id: 'call-status-first-turn',
        name: 'run_shell',
        args: { command: 'git status --short' },
      }],
      [],
      [{
        id: 'call-status-second-turn',
        name: 'run_shell',
        args: { command: 'git status --short' },
      }],
      [],
      [{
        id: 'call-status-after-registry-reload',
        name: 'run_shell',
        args: { command: 'git status --short' },
      }],
      [],
      [{
        id: 'call-status-new-session',
        name: 'run_shell',
        args: { command: 'git status --short' },
      }],
      [],
    ],
  });
  const checkpoint = new MemorySaver();
  const graphConfig = {
    models: {
      act: routeModel,
      observe: autoReviewModel,
      subagent: subagentModel,
    },
    actor: testActor,
    checkpoint,
  };
  const invokeConfig = {
    configurable: {
      thread_id: 'auto-authorization-across-graph-rebuild',
      actor: testActor,
      capabilities: [capability('general', 'General-purpose capability.', ['bash'])],
      toolkits,
      reviewCapabilities: {
        humanReview: false,
        sessionAuthorization: true,
      },
      globalReviewPolicy: { mode: 'auto_authorization' },
    },
  };

  const firstGraph = createOrchestratorGraph(graphConfig);
  const firstState = await firstGraph.invoke(
    buildOrchestratorRunInput([new HumanMessage('inspect repository status')]),
    invokeConfig,
  ) as {
    sessionToolAuthorizations: {
      generation: string;
      records: ToolAuthorizationRecord[];
    };
  };
  assert.equal(runCount, 1);
  assert.equal(autoReviewCount, 1);
  assert.deepEqual(
    firstState.sessionToolAuthorizations.records
      .map(({ createdAt: _createdAt, ...record }) => record),
    [{
      toolName: 'run_shell',
      matcher: exactAuthorization({ command: 'git status --short' }),
      source: 'auto_review',
    }],
  );
  assert.doesNotMatch(JSON.stringify(firstState.sessionToolAuthorizations), /git status --short/);
  assert.match(firstState.sessionToolAuthorizations.generation, /^[a-f0-9]{64}$/);

  const rebuiltGraph = createOrchestratorGraph(graphConfig);
  const secondState = await rebuiltGraph.invoke(
    buildOrchestratorRunInput([new HumanMessage('inspect repository status again')]),
    invokeConfig,
  ) as typeof firstState;

  assert.equal(runCount, 2);
  assert.equal(autoReviewCount, 1);
  assert.equal(secondState.sessionToolAuthorizations.records.length, 1);
  assert.equal(
    secondState.sessionToolAuthorizations.generation,
    firstState.sessionToolAuthorizations.generation,
  );

  const reloadedToolkits: AgentToolkit[] = [{
    name: 'bash',
    description: 'bash tools',
    tools: [reviewedTool(
      rawTool,
      ReviewPolicies.commandExecution({
        authorization: AuthorizationPolicies.exact({
          subject: ({ input }) => input,
        }),
      }),
    )],
  }];
  const reloadedConfig = {
    configurable: {
      ...invokeConfig.configurable,
      toolkits: reloadedToolkits,
    },
  };
  const reloadedState = await rebuiltGraph.invoke(
    buildOrchestratorRunInput([new HumanMessage('inspect after plugin reload')]),
    reloadedConfig,
  ) as typeof firstState;

  assert.equal(runCount, 3);
  assert.equal(autoReviewCount, 2);
  assert.equal(reloadedState.sessionToolAuthorizations.records.length, 1);
  assert.notEqual(
    reloadedState.sessionToolAuthorizations.generation,
    firstState.sessionToolAuthorizations.generation,
  );

  await rebuiltGraph.invoke(
    buildOrchestratorRunInput([new HumanMessage('inspect from a new session')]),
    {
      configurable: {
        ...reloadedConfig.configurable,
        thread_id: 'auto-authorization-isolated-session',
      },
    },
  );
  assert.equal(runCount, 4);
  assert.equal(autoReviewCount, 3);
});

test('global review policy does not record auto grants for policies without session authorization', async () => {
  let autoReviewCount = 0;
  const sessionAuthorizations: ToolAuthorizationRecord[] = [];
  const rawTool = tool(async ({ command }: { command: string }) => `ran ${command}`, {
    name: 'run_shell',
    description: 'run shell',
    schema: z.object({ command: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'bash',
    description: 'bash tools',
    tools: [reviewedTool(rawTool, ReviewPolicies.commandExecution())],
  }];
  const autoModel = {
    withStructuredOutput: () => ({
      invoke: async () => {
        autoReviewCount += 1;
        return {
          riskScore: 1,
          reason: 'The command is safe but the tool policy does not support session authorization.',
        };
      },
    }),
  } as unknown as AgentModels['act'];
  const resources = await resolveToolkitExecution(toolkits, ['bash'], {
    models: { act: autoModel },
    actor: testActor,
    messages: [],
    reviewCapabilities: {
      humanReview: true,
      sessionAuthorization: true,
    },
    globalReviewPolicy: { mode: 'auto_authorization' },
    toolAuthorizations: sessionAuthorizations,
    recordToolAuthorizations: (authorizations) => {
      sessionAuthorizations.push(...authorizations);
    },
  });

  await runToolkitToolCall(resources, {
    id: 'call-status-no-grant-1',
    name: 'run_shell',
    args: { command: 'git status --short' },
  });
  await runToolkitToolCall(resources, {
    id: 'call-status-no-grant-2',
    name: 'run_shell',
    args: { command: 'git status --short' },
  });

  assert.equal(autoReviewCount, 2);
  assert.deepEqual(sessionAuthorizations, []);
});

test('auto review never persists url_origin grants', async () => {
  let callCount = 0;
  let autoReviewCount = 0;
  const sessionAuthorizations: ToolAuthorizationRecord[] = [];
  const rawTool = tool(async ({ url }: { url: string }) => {
    callCount += 1;
    return `opened ${url}`;
  }, {
    name: 'browser_open',
    description: 'open browser URL',
    schema: z.object({ url: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'browser',
    description: 'browser tools',
    tools: [reviewedTool(
      rawTool,
      ReviewPolicies.externalAccess({ authorization: 'url_origin' }),
    )],
  }];
  const autoModel = {
    withStructuredOutput: () => ({
      invoke: async () => {
        autoReviewCount += 1;
        return { riskScore: 1, reason: 'Scoped browser navigation.' };
      },
    }),
  } as unknown as AgentModels['act'];
  const resources = await resolveToolkitExecution(toolkits, ['browser'], {
    models: { act: autoModel },
    actor: testActor,
    messages: [],
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: true,
    },
    globalReviewPolicy: { mode: 'auto_authorization' },
    toolAuthorizations: sessionAuthorizations,
    recordToolAuthorizations: (authorizations) => {
      sessionAuthorizations.push(...authorizations);
    },
  });

  for (const id of ['call-browser-1', 'call-browser-2']) {
    await runToolkitToolCall(resources, {
      id,
      name: 'browser_open',
      args: { url: 'https://example.test/docs' },
    });
  }

  assert.equal(callCount, 2);
  assert.equal(autoReviewCount, 2);
  assert.deepEqual(sessionAuthorizations, []);
});

test('matcher builder failures fail closed into review and never persist a grant', async () => {
  let callCount = 0;
  let autoReviewCount = 0;
  const sessionAuthorizations: ToolAuthorizationRecord[] = [];
  const rawTool = tool(async () => {
    callCount += 1;
    return 'ran';
  }, {
    name: 'run_shell',
    description: 'run shell',
    schema: z.object({ command: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'bash',
    description: 'bash tools',
    tools: [reviewedTool(
      rawTool,
      ReviewPolicies.commandExecution({
        authorization: AuthorizationPolicies.exact({
          subject: () => {
            throw new Error('invalid authorization subject');
          },
        }),
      }),
    )],
  }];
  const autoModel = {
    withStructuredOutput: () => ({
      invoke: async () => {
        autoReviewCount += 1;
        return { riskScore: 1, reason: 'Allow this current call only.' };
      },
    }),
  } as unknown as AgentModels['act'];
  const resources = await resolveToolkitExecution(toolkits, ['bash'], {
    models: { act: autoModel },
    actor: testActor,
    messages: [],
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: true,
    },
    globalReviewPolicy: { mode: 'auto_authorization' },
    toolAuthorizations: sessionAuthorizations,
    recordToolAuthorizations: (authorizations) => {
      sessionAuthorizations.push(...authorizations);
    },
  });

  for (const id of ['call-invalid-matcher-1', 'call-invalid-matcher-2']) {
    await runToolkitToolCall(resources, {
      id,
      name: 'run_shell',
      args: { command: 'npm test' },
    });
  }

  assert.equal(callCount, 2);
  assert.equal(autoReviewCount, 2);
  assert.deepEqual(sessionAuthorizations, []);
});

test('global review policy auto_authorization evaluates a tool-call batch once', async () => {
  let firstCallCount = 0;
  let secondCallCount = 0;
  let autoReviewCount = 0;
  let autoReviewMessages: unknown;
  const runtimeEvents: unknown[] = [];
  const firstTool = tool(async ({ path }: { path: string }) => {
    firstCallCount += 1;
    return `first ${path}`;
  }, {
    name: 'first_write',
    description: 'first write',
    schema: z.object({ path: z.string(), content: z.string() }),
  });
  const secondTool = tool(async ({ path }: { path: string }) => {
    secondCallCount += 1;
    return `second ${path}`;
  }, {
    name: 'second_write',
    description: 'second write',
    schema: z.object({ path: z.string(), content: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [
      reviewedTool(firstTool, ReviewPolicies.localMutation()),
      reviewedTool(secondTool, ReviewPolicies.localMutation()),
    ],
    reviewGuidance: {
      allow: 'Allow narrow writes to user-requested files.',
      ask: 'Ask before broad or destructive writes.',
    },
  }];
  const autoModel = {
    withStructuredOutput: () => ({
      invoke: async (messages: unknown) => {
        autoReviewCount += 1;
        autoReviewMessages = messages;
        return {
          riskScore: 1,
          reason: 'Both writes are narrow and expected.',
        };
      },
    }),
  } as unknown as AgentModels['act'];

  const resources = await resolveToolkitExecution(toolkits, ['local'], {
    models: { act: autoModel },
    actor: testActor,
    messages: [new HumanMessage('write both files')],
    reviewContext: {
      task: 'Write both requested files',
      workdir: '/repo',
    },
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: false,
    },
    globalReviewPolicy: { mode: 'auto_authorization' },
    emitRuntimeEvent: (event) => {
      runtimeEvents.push(event);
    },
  });

  const result = await runToolkitToolCall(resources, [
    {
      id: 'call-first-write',
      name: 'first_write',
      args: { path: 'a.txt', content: 'a' },
    },
    {
      id: 'call-second-write',
      name: 'second_write',
      args: { path: 'b.txt', content: 'b' },
    },
  ]);

  assert.equal(readToolMessageContent(result.messages, 'call-first-write'), 'first a.txt');
  assert.equal(readToolMessageContent(result.messages, 'call-second-write'), 'second b.txt');
  assert.equal(firstCallCount, 1);
  assert.equal(secondCallCount, 1);
  assert.equal(autoReviewCount, 1);
  const [systemMessage, humanMessage] = autoReviewMessages as Array<{ content?: unknown }>;
  const systemPrompt = String(systemMessage?.content);
  const reviewPrompt = String(humanMessage?.content);
  assert.match(reviewPrompt, /<batch_size>2<\/batch_size>/);
  assert.match(reviewPrompt, /local\.first_write/);
  assert.match(reviewPrompt, /local\.second_write/);
  assert.match(reviewPrompt, /a\.txt/);
  assert.match(reviewPrompt, /b\.txt/);
  assert.match(systemPrompt, /Toolkit local:/);
  assert.equal(
    systemPrompt.match(/Automatic-authorization eligibility: narrow writes to user-requested files\./g)?.length,
    1,
  );
  assert.equal(
    systemPrompt.match(/Human-authorization conditions: before broad or destructive writes\./g)?.length,
    1,
  );
  assert.doesNotMatch(reviewPrompt, /Toolkit local:|narrow writes to user-requested files/);
  const authorizationEvent = runtimeEvents[0] as {
    name?: unknown;
    data?: { batchSize?: unknown; toolCalls?: unknown[] };
  } | undefined;
  assert.equal(authorizationEvent?.name, 'global_review_policy_auto_authorized');
  assert.equal(authorizationEvent?.data?.batchSize, 2);
  assert.equal(authorizationEvent?.data?.toolCalls?.length, 2);
});

test('global review policy auto_authorization requires human authorization when unsure', async () => {
  let callCount = 0;
  const rawTool = tool(async () => {
    callCount += 1;
    return 'raw ok';
  }, {
    name: 'write_file',
    description: 'write file',
    schema: z.object({ path: z.string(), content: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [reviewedTool(rawTool, ReviewPolicies.localMutation())],
  }];
  const autoModel = {
    withStructuredOutput: () => ({
      invoke: async () => ({
        riskScore: 10,
        reason: 'The write looks too broad.',
      }),
    }),
  } as unknown as AgentModels['act'];

  const resources = await resolveToolkitExecution(toolkits, ['local'], {
    models: { act: autoModel },
    actor: testActor,
    messages: [new HumanMessage('rewrite the project')],
    reviewContext: {
      task: 'Rewrite the project',
      workdir: '/repo',
    },
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: false,
    },
    globalReviewPolicy: { mode: 'auto_authorization' },
  });

  const result = await runToolkitToolCall(resources, {
    id: 'call-unsafe-write',
    name: 'write_file',
    args: { path: 'src/index.ts', content: 'new content' },
  });
  const parsed = JSON.parse(String(readToolMessageContent(
    result.messages,
    'call-unsafe-write',
  ))) as {
    cancelled?: boolean;
    guidance?: string;
    reason?: string;
    source?: string;
  };
  assert.equal(callCount, 0);
  assert.equal(parsed.cancelled, true);
  assert.equal(parsed.source, 'review_unavailable');
  assert.match(parsed.reason ?? '', /too broad/);
  assert.match(parsed.guidance ?? '', /human authorization.*unavailable/);
  const lastMessage = result.messages.at(-1);
  assert.ok(AIMessage.isInstance(lastMessage));
  assert.match(String(lastMessage.content), /当前运行环境无法收集确认/);
});

test('global review policy custom resolver can authorize reviewed tool calls', async () => {
  let callCount = 0;
  let customReviewTitle: string | null = null;
  const rawTool = tool(async () => {
    callCount += 1;
    return 'raw ok';
  }, {
    name: 'write_file',
    description: 'write file',
    schema: z.object({ path: z.string(), content: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [reviewedTool(rawTool, ReviewPolicies.localMutation())],
  }];

  const resources = await resolveToolkitExecution(toolkits, ['local'], {
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: false,
    },
    globalReviewPolicy: {
      mode: 'custom',
      resolve: (ctx) => {
        customReviewTitle = ctx.review.view.title ?? null;
        return { type: 'authorize', reason: 'custom policy allowed it' };
      },
    },
  });

  const result = await runToolkitToolCall(resources, {
    id: 'call-custom-write',
    name: 'write_file',
    args: { path: 'notes.md', content: 'hello' },
  });
  assert.equal(readToolMessageContent(result.messages, 'call-custom-write'), 'raw ok');
  assert.equal(callCount, 1);
  assert.equal(customReviewTitle, 'write_file');
});

test('custom review policy explicitly opts in before reusing auto grants', async () => {
  let callCount = 0;
  let customReviewCount = 0;
  const input = { path: 'notes.md', content: 'hello' };
  const rawTool = tool(async () => {
    callCount += 1;
    return 'raw ok';
  }, {
    name: 'write_file',
    description: 'write file',
    schema: z.object({ path: z.string(), content: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [reviewedTool(
      rawTool,
      ReviewPolicies.localMutation({ authorization: 'exact' }),
    )],
  }];
  const resources = await resolveToolkitExecution(toolkits, ['local'], {
    models: {} as AgentModels,
    actor: testActor,
    messages: [],
    reviewCapabilities: {
      humanReview: false,
      sessionAuthorization: true,
    },
    globalReviewPolicy: {
      mode: 'custom',
      reuseAutoAuthorizations: true,
      resolve: () => {
        customReviewCount += 1;
        return { type: 'authorize', reason: 'custom policy allowed it' };
      },
    },
    toolAuthorizations: [{
      toolName: 'write_file',
      matcher: exactAuthorization(input),
      source: 'auto_review',
      createdAt: '2026-07-31T00:00:00.000Z',
    }],
  });

  const result = await runToolkitToolCall(resources, {
    id: 'call-custom-reused-auto-grant',
    name: 'write_file',
    args: input,
  });

  assert.equal(readToolMessageContent(result.messages, 'call-custom-reused-auto-grant'), 'raw ok');
  assert.equal(callCount, 1);
  assert.equal(customReviewCount, 0);
});

test('toolkit review policy records authorization through orchestrator runtime topology', async () => {
  let runCount = 0;
  let reviewCount = 0;
  const rawTool = tool(async ({ command }: { command: string }) => {
    runCount += 1;
    return `ran ${command}`;
  }, {
    name: 'run_shell',
    description: 'run shell',
    schema: z.object({ command: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [reviewedTool(rawTool, {
          request: () => {
            reviewCount += 1;
            return buildReviewSpec({
              view: { kind: 'plain', body: 'Approve shell?' },
              options: [{
                id: 'approve-and-authorize-thread',
                label: 'Approve and authorize',
                decision: { type: 'approve' },
                effects: [{
                  type: 'graph.authorize_tool_action',
                  scope: 'thread',
                }],
              }],
            });
          },
          authorization: AuthorizationPolicies.exact(),
    })],
  }];

  let routeCallCount = 0;
  const runtimeEvents: unknown[] = [];
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        if (routeCallCount === 1) {
          return scriptedPlannerTask('run shell');
        }
        if (routeCallCount === 2) {
          return scriptedPlannerCapability('general');
        }
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeToolCallingModel({
    toolCalls: [
      [{
        id: 'call-1',
        name: 'run_shell',
        args: { command: 'git status' },
      }],
      [{
        id: 'call-2',
        name: 'run_shell',
        args: { command: 'git status' },
      }],
      [],
    ],
  });
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: subagentModel,
    },
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const config = {
    configurable: {
      thread_id: 'canonical-review-runtime-auth',
      actor: testActor,
      capabilities: [capability('general', 'General-purpose capability.', ['local'])],
      toolkits,
    },
  };
  const input = buildOrchestratorRunInput([new HumanMessage('run git status')]);

  const interrupted = await graph.invoke(input, config) as {
    __interrupt__?: Array<{ id?: string; value?: unknown }>;
  };
  const interruptId = interrupted.__interrupt__?.[0]?.id;
  const payload = interrupted.__interrupt__?.[0]?.value as {
    kind?: string;
    reviews?: Array<{ review?: { id?: string } }>;
  } | undefined;
  assert.equal(payload?.kind, 'review_batch');
  assert.deepEqual(payload?.reviews?.map((item) => item.review?.id), [
    'tool-review:run_shell:call-1',
  ]);
  assert.equal(reviewCount, 1);

  subagentModel.index = 0;
  // Authorization runtime events ride the stream writer (#322): resume via
  // the root protocol stream and collect `custom` events.
  const reviewResume = {
    decisions: [{
      reviewId: 'tool-review:run_shell:call-1',
      selectedOptionId: 'approve-and-authorize-thread',
    }],
  };
  const resumedRun = await graph.streamEvents(new Command({
    resume: interruptId ? { [interruptId]: reviewResume } : reviewResume,
  }), { version: 'v3', ...config });
  for await (const event of resumedRun) {
    if (event.method === 'custom') {
      runtimeEvents.push(event.params.data);
    }
  }
  const finalState = await resumedRun.output as {
    __interrupt__?: unknown;
    sessionToolAuthorizations: {
      generation: string;
      records: Array<{ toolName: string; matcher: unknown; createdAt: string }>;
    };
  };

  assert.equal(finalState.__interrupt__, undefined);
  assert.deepEqual(
    finalState.sessionToolAuthorizations.records
      .map(({ createdAt: _createdAt, ...item }) => item),
    [{
      toolName: 'run_shell',
      matcher: exactAuthorization({ command: 'git status' }),
      source: 'human',
    }],
  );
  const authorizationEvents = runtimeEvents.filter((event) =>
    event
    && typeof event === 'object'
    && (event as { event?: unknown }).event === 'on_runtime_event'
    && (event as { name?: unknown }).name === 'tool_authorization_recorded');
  assert.equal(authorizationEvents.length, 1);
  const eventAuthorization = (authorizationEvents[0] as { data?: {
    toolName: string;
    matcherType: string;
    source: string;
    scope: string;
  } }).data;
  assert.deepEqual(eventAuthorization, {
    toolName: 'run_shell',
    matcherType: 'exact',
    source: 'human',
    scope: 'thread',
  });
  // Resuming a LangGraph interrupt replays the node and rebuilds the same
  // deterministic review request before consuming the saved decision.
  assert.equal(reviewCount, 2);
  assert.equal(runCount, 1);
});

test('toolkit review policy resumes plain approve through interrupt checkpoint', async () => {
  let runCount = 0;
  let reviewCount = 0;
  const rawTool = tool(async ({ command }: { command: string }) => {
    runCount += 1;
    return `ran ${command}`;
  }, {
    name: 'run_shell',
    description: 'run shell',
    schema: z.object({ command: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [reviewedTool(rawTool, {
          request: () => {
            reviewCount += 1;
            return buildReviewSpec({
              view: { kind: 'plain', body: 'Approve shell once?' },
              options: [{
                id: 'approve',
                label: 'Approve',
                decision: { type: 'approve' },
              }],
            });
          },
    })],
  }];

  let routeCallCount = 0;
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        if (routeCallCount === 1) {
          return scriptedPlannerTask('run shell');
        }
        if (routeCallCount === 2) {
          return scriptedPlannerCapability('general');
        }
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeToolCallingModel({
    toolCalls: [
      [{
        id: 'call-plain-1',
        name: 'run_shell',
        args: { command: 'git status' },
      }],
      [],
    ],
  });
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: subagentModel,
    },
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const config = {
    configurable: {
      thread_id: 'plain-review-runtime-state',
      actor: testActor,
      capabilities: [capability('general', 'General-purpose capability.', ['local'])],
      toolkits,
    },
  };

  const interrupted = await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage('run git status')]),
    config,
  ) as {
    __interrupt__?: Array<{ id?: string; value?: unknown }>;
  };
  const interruptId = interrupted.__interrupt__?.[0]?.id;
  const payload = interrupted.__interrupt__?.[0]?.value as {
    kind?: string;
    reviews?: Array<{ review?: { id?: string } }>;
  } | undefined;
  assert.equal(payload?.kind, 'review_batch');
  assert.deepEqual(payload?.reviews?.map((item) => item.review?.id), [
    'tool-review:run_shell:call-plain-1',
  ]);

  // Resume with the fake model's tool-free response. A tool result is evidence,
  // not an implicit subagent deliverable.
  subagentModel.index = 1;
  const reviewResume = {
    decisions: [{
      reviewId: 'tool-review:run_shell:call-plain-1',
      selectedOptionId: 'approve',
    }],
  };
  const resumedRun = await graph.streamEvents(new Command({
    resume: interruptId ? { [interruptId]: reviewResume } : reviewResume,
  }), { version: 'v3', ...config });
  for await (const _event of resumedRun) {
    // Drain the root stream so the final output is materialized.
  }
  const finalState = await resumedRun.output as {
    __interrupt__?: unknown;
    messages: Array<AIMessage | HumanMessage | ToolMessage>;
    runId: string;
  };

  assert.equal(finalState.__interrupt__, undefined);
  assert.equal(reviewCount, 2);
  assert.equal(runCount, 1);
  // After the resumed tool approval, the Planner boundary finishes the task.
  // The result is handed off into the main queue and the private messages is
  // cleared, so continuation state is no longer inferred from a stale announce.
  const handoffCopy = mainConversationMessages(finalState.messages)
    .find((message) => getMessageHandoffSource(message)?.task === 'run shell');
  assert.ok(handoffCopy, JSON.stringify(finalState.messages.map((message) => ({
    type: message._getType(),
    content: message.content,
    meta: getAgentMessageMetadata(message),
  }))));
  const handoffSource = getMessageHandoffSource(handoffCopy);
  assert.equal(handoffSource?.handoffFrom, 'capability:general');
  assert.ok(handoffSource?.delegationId);
  assert.equal(handoffSource?.task, 'run shell');
  assert.ok(handoffSource?.announceMessageId);
  assert.match(String(handoffCopy.content), /ran git status/);
  assert.equal(readLatestAnnounce(finalState.messages, {
    lane: handoffSource?.handoffFrom ?? 'capability:general',
    runId: handoffSource?.runId ?? finalState.runId,
    delegationId: handoffSource?.delegationId ?? '',
  }), null);
});

test('toolkit review rejection rolls back the full action and retains the delegation', async () => {
  let runCount = 0;
  let reviewCount = 0;
  let autoReviewCount = 0;
  const rawTool = tool(async ({ command }: { command: string }) => {
    runCount += 1;
    return `ran ${command}`;
  }, {
    name: 'run_shell',
    description: 'run shell',
    schema: z.object({ command: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [reviewedTool(rawTool, {
          request: () => {
            reviewCount += 1;
            return buildReviewSpec({
              view: { kind: 'plain', body: 'Approve shell?' },
              options: [
                {
                  id: 'approve',
                  label: 'Approve',
                  decision: { type: 'approve' },
                },
                {
                  id: 'reject',
                  label: 'Reject',
                  decision: {
                    type: 'reject',
                    message: '不要发 PR comment，直接给我结果。',
                  },
                },
              ],
            });
          },
    })],
  }];

  let routeCallCount = 0;
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        if (routeCallCount === 1) {
          return scriptedPlannerTask('run shell');
        }
        if (routeCallCount === 2) {
          return scriptedPlannerCapability('general');
        }
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeToolCallingModel({
    toolCalls: [
      [
        {
          id: 'call-rejected-first',
          name: 'run_shell',
          args: { command: 'git status' },
        },
        {
          id: 'call-rejected-second',
          name: 'run_shell',
          args: { command: 'git diff --stat' },
        },
      ],
      [{
        id: 'call-after-continue',
        name: 'run_shell',
        args: { command: 'git log -1' },
      }],
      [],
    ],
  });
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: subagentModel,
    },
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const recorder = createSubagentInputRecorder();
  const config = {
    callbacks: recorder.callbacks,
    configurable: {
      thread_id: 'human-reject-resumes-subagent-loop',
      actor: testActor,
      capabilities: [capability('general', 'General-purpose capability.', ['local'])],
      toolkits,
      reviewCapabilities: {
        humanReview: true,
        sessionAuthorization: false,
      },
      globalReviewPolicy: {
        mode: 'custom',
        resolve: () => {
          autoReviewCount += 1;
          return { type: 'require_authorization' as const };
        },
      },
    },
  };

  const interrupted = await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage('run git status')]),
    config,
  ) as {
    __interrupt__?: Array<{ id?: string; value?: unknown }>;
  };
  const interruptId = interrupted.__interrupt__?.[0]?.id;
  const payload = interrupted.__interrupt__?.[0]?.value as {
    kind?: string;
    reviews?: Array<{ review?: { id?: string } }>;
  } | undefined;
  assert.equal(payload?.kind, 'review_batch');
  assert.deepEqual(payload?.reviews?.map((item) => item.review?.id), [
    'tool-review:run_shell:call-rejected-first',
    'tool-review:run_shell:call-rejected-second',
  ]);

  const reviewResume = {
    decisions: [{
      reviewId: 'tool-review:run_shell:call-rejected-first',
      selectedOptionId: 'reject',
    }],
  };
  const resumedRun = await graph.streamEvents(new Command({
    resume: interruptId ? { [interruptId]: reviewResume } : reviewResume,
  }), { version: 'v3', ...config });
  for await (const _event of resumedRun) {
    // Drain the root stream so the final output is materialized.
  }
  const finalState = await resumedRun.output as {
    __interrupt__?: unknown;
    messages: BaseMessage[];
    taskActiveDelegation: TaskActiveDelegation | null;
  };

  assert.equal(finalState.__interrupt__, undefined);
  assert.equal(runCount, 0);
  assert.equal(reviewCount, 4);
  assert.equal(autoReviewCount, 1, 'pending review resume must reuse its checkpointed auto-review');
  assert.equal(routeCallCount, 2);
  assert.equal(recorder.subagentInputs.length, 1);
  const handoffCopy = mainConversationMessages(finalState.messages)
    .find((message) => Boolean(getMessageHandoffSource(message)));
  assert.equal(handoffCopy, undefined);
  assert.equal(finalState.taskActiveDelegation?.status, 'pending');

  const activeDelegation = finalState.taskActiveDelegation;
  assert.ok(activeDelegation);
  const retainedLane = selectCapabilityHistory(
    finalState.messages,
    activeDelegation.lane,
    activeDelegation.runId,
    activeDelegation.id,
  );
  assert.equal(
    retainedLane.some((message) => ToolMessage.isInstance(message)),
    false,
  );
  assert.equal(
    retainedLane.some((message) =>
      AIMessage.isInstance(message)
      && (message.tool_calls ?? []).some((toolCall) =>
        toolCall.id === 'call-rejected-first' || toolCall.id === 'call-rejected-second')),
    false,
  );

  const nextReview = await graph.invoke(
    buildOrchestratorRunInput(
      [new HumanMessage('continue without the rejected action')],
      { activeDelegationTransition: 'resume_active' },
    ),
    config,
  ) as {
    __interrupt__?: Array<{ id?: string; value?: unknown }>;
  };
  const nextPayload = nextReview.__interrupt__?.[0]?.value as {
    reviews?: Array<{ review?: { id?: string } }>;
  } | undefined;
  assert.deepEqual(nextPayload?.reviews?.map((item) => item.review?.id), [
    'tool-review:run_shell:call-after-continue',
  ]);
  assert.equal(autoReviewCount, 2, 'a later capability review must run auto-review normally');
  const continuedSubagentInput = recorder.subagentInputs.at(-1) ?? [];
  assert.equal(
    continuedSubagentInput.some((message) => ToolMessage.isInstance(message)),
    false,
  );
  assert.equal(
    continuedSubagentInput.some((message) =>
      HumanMessage.isInstance(message)
      && String(message.content).includes('continue without the rejected action')),
    true,
  );
});

test('toolkit review run interruption retains the delegation without another model call or handoff', async () => {
  let runCount = 0;
  let reviewCount = 0;
  const rawTool = tool(async ({ command }: { command: string }) => {
    runCount += 1;
    return `ran ${command}`;
  }, {
    name: 'run_shell',
    description: 'run shell',
    schema: z.object({ command: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [reviewedTool(rawTool, {
      request: () => {
        reviewCount += 1;
        return buildReviewSpec({
          view: { kind: 'plain', body: 'Approve shell?' },
          options: [{
            id: 'approve',
            label: 'Approve',
            decision: { type: 'approve' },
          }],
        });
      },
    })],
  }];

  let routeCallCount = 0;
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        if (routeCallCount === 1) {
          return scriptedPlannerTask('run shell');
        }
        if (routeCallCount === 2) {
          return scriptedPlannerCapability('general');
        }
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeToolCallingModel({
    toolCalls: [
      [{
        id: 'call-interrupted',
        name: 'run_shell',
        args: { command: 'git status' },
      }],
      [],
    ],
  });
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: subagentModel,
    },
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const recorder = createSubagentInputRecorder();
  let finalizeCallCount = 0;
  const reviewedCapability = {
    ...capability('general', 'General-purpose capability.', ['local']),
    lifecycle: {
      finalize: () => {
        finalizeCallCount += 1;
      },
    },
  };
  const config = {
    callbacks: recorder.callbacks,
    configurable: {
      thread_id: 'human-review-interrupt-retains-delegation',
      actor: testActor,
      capabilities: [reviewedCapability],
      toolkits,
    },
  };

  const interrupted = await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage('run git status')]),
    config,
  ) as {
    __interrupt__?: Array<{ id?: string; value?: unknown }>;
  };
  const interruptId = interrupted.__interrupt__?.[0]?.id;
  assert.ok(interruptId);

  const resumedRun = await graph.streamEvents(new Command({
    resume: {
      [interruptId]: { action: 'interrupt_run' },
    },
  }), { version: 'v3', ...config });
  for await (const _event of resumedRun) {
    // Drain the root stream so the retained delegation checkpoint is materialized.
  }
  const finalState = await resumedRun.output as {
    __interrupt__?: unknown;
    messages: BaseMessage[];
    runNextDelegation: unknown;
    runPlannerSession: OrchestratorStateType['runPlannerSession'];
    taskActiveDelegation: TaskActiveDelegation | null;
    taskPlannerContinuation: OrchestratorStateType['taskPlannerContinuation'];
  };

  assert.equal(finalState.__interrupt__, undefined);
  assert.equal(runCount, 0);
  assert.equal(reviewCount, 2);
  assert.equal(routeCallCount, 2);
  assert.equal(recorder.subagentInputs.length, 1);
  assert.equal(finalizeCallCount, 0);
  assert.equal(finalState.runNextDelegation, null);
  assert.equal(finalState.taskActiveDelegation?.status, 'pending');
  assert.equal(finalState.runPlannerSession, null);
  assert.equal(
    finalState.taskPlannerContinuation?.activeDelegationId,
    finalState.taskActiveDelegation?.id,
  );
  assert.deepEqual(finalState.taskPlannerContinuation?.remainingPlan, []);
  assert.equal(
    mainConversationMessages(finalState.messages)
      .some((message) => Boolean(getMessageHandoffSource(message))),
    false,
  );

  const activeDelegation = finalState.taskActiveDelegation;
  assert.ok(activeDelegation);
  const retainedLane = selectCapabilityHistory(
    finalState.messages,
    activeDelegation.lane,
    activeDelegation.runId,
    activeDelegation.id,
  );
  const cancelledToolResult = retainedLane.find((message) =>
    message instanceof ToolMessage
    && message.tool_call_id === 'call-interrupted');
  assert.equal(cancelledToolResult, undefined);
  assert.equal(
    retainedLane.some((message) =>
      AIMessage.isInstance(message)
      && (message.tool_calls ?? []).some((toolCall) => toolCall.id === 'call-interrupted')),
    false,
  );

  const retainedDelegationId = activeDelegation.id;
  const continuedState = await graph.invoke(
    buildOrchestratorRunInput(
      [new HumanMessage('continue the suspended delegation')],
      { activeDelegationTransition: 'resume_active' },
    ),
    config,
  ) as {
    messages: BaseMessage[];
    taskActiveDelegation: TaskActiveDelegation | null;
  };

  assert.equal(routeCallCount, 3);
  assert.equal(recorder.subagentInputs.length, 2);
  assert.equal(finalizeCallCount, 1);
  const continuedSubagentInput = recorder.subagentInputs.at(-1) ?? [];
  assert.equal(
    continuedSubagentInput.some((message) => ToolMessage.isInstance(message)),
    false,
  );
  const resumedHandoff = mainConversationMessages(continuedState.messages)
    .map((message) => getMessageHandoffSource(message))
    .find((source) => source?.delegationId === retainedDelegationId);
  assert.ok(resumedHandoff);
  assert.equal(continuedState.taskActiveDelegation, null);
});

test('toolkit review resumes multiple reviewed tool calls in one model response', async () => {
  let runCount = 0;
  let reviewCount = 0;
  const rawTool = tool(async ({ command }: { command: string }) => {
    runCount += 1;
    return `ran ${command}`;
  }, {
    name: 'run_shell',
    description: 'run shell',
    schema: z.object({ command: z.string() }),
  });
  const toolkits: AgentToolkit[] = [{
    name: 'local',
    description: 'local tools',
    tools: [reviewedTool(rawTool, {
          request: () => {
            reviewCount += 1;
            return buildReviewSpec({
              view: { kind: 'plain', body: 'Approve shell?' },
              options: [{
                id: 'approve',
                label: 'Approve',
                decision: { type: 'approve' },
              }],
            });
          },
    })],
  }];

  let routeCallCount = 0;
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        if (routeCallCount === 1) {
          return scriptedPlannerTask('run shell twice');
        }
        if (routeCallCount === 2) {
          return scriptedPlannerCapability('general');
        }
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeToolCallingModel({
    toolCalls: [
      [
        {
          id: 'call-first',
          name: 'run_shell',
          args: { command: 'git status' },
        },
        {
          id: 'call-second',
          name: 'run_shell',
          args: { command: 'git diff' },
        },
      ],
      [],
    ],
  });
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: subagentModel,
    },
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const config = {
    configurable: {
      thread_id: 'multi-tool-review-runtime-state',
      actor: testActor,
      capabilities: [capability('general', 'General-purpose capability.', ['local'])],
      toolkits,
    },
  };

  const firstInterrupt = await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage('run git status and git diff')]),
    config,
  ) as {
    __interrupt__?: Array<{ id?: string; value?: unknown }>;
  };
  const interruptId = firstInterrupt.__interrupt__?.[0]?.id;
  const batchPayload = firstInterrupt.__interrupt__?.[0]?.value as {
    kind?: string;
    reviews?: Array<{ review?: { id?: string } }>;
  } | undefined;
  assert.equal(batchPayload?.kind, 'review_batch');
  assert.deepEqual(batchPayload?.reviews?.map((item) => item.review?.id), [
    'tool-review:run_shell:call-first',
    'tool-review:run_shell:call-second',
  ]);

  subagentModel.index = 0;
  const batchResume = {
    decisions: [
      {
        reviewId: 'tool-review:run_shell:call-first',
        selectedOptionId: 'approve',
      },
      {
        reviewId: 'tool-review:run_shell:call-second',
        selectedOptionId: 'approve',
      },
    ],
  };
  const resumedRun = await graph.streamEvents(new Command({
    resume: interruptId ? { [interruptId]: batchResume } : batchResume,
  }), { version: 'v3', ...config });
  for await (const _event of resumedRun) {
    // Drain the root stream so the final output is materialized.
  }
  const finalState = await resumedRun.output as {
    __interrupt__?: unknown;
    messages: Array<AIMessage | HumanMessage | ToolMessage>;
  };

  assert.equal(finalState.__interrupt__, undefined);
  assert.equal(runCount, 2);
  assert.equal(reviewCount, 4);
});

test('buildSubagentHandoff copies the announce into main and wipes the whole delegation lane', () => {
  const userAsk = new HumanMessage('帮我查一下公开资料');
  const intermediate = new AIMessage('正在抓取页面…');
  intermediate.id = 'm-intermediate';
  setAgentMessageMetadata(intermediate, { lane: 'capability:explore', runId: 't1', delegationId: 'd1' });
  const announce = createPrivateAnnounce({
    id: 'm-announce',
    lane: 'capability:explore',
    runId: 't1',
    delegationId: 'd1',
    task: '查动态',
    result: '已查到热门动态：A、B、C。FULL_ANNOUNCE_MARKER',
  });
  // A different delegation in the same lane must be untouched.
  const otherDelegation = new AIMessage('另一个 delegation 的中间消息');
  otherDelegation.id = 'm-other';
  setAgentMessageMetadata(otherDelegation, { lane: 'capability:explore', runId: 't1', delegationId: 'd2' });

  const messages = [userAsk, intermediate, announce, otherDelegation];
  const update = buildSubagentHandoff({
    messages,
    lane: 'capability:explore',
    runId: 't1',
    delegationId: 'd1',
  });
  assert.ok(update, 'handoff update should be produced for a completed delegation');

  const removed = update.filter((m) => m instanceof RemoveMessage).map((m) => m.id);
  // d1's announce + intermediate are removed; d2 and the user message are not.
  assert.deepEqual(new Set(removed), new Set(['m-intermediate', 'm-announce']));

  const copies = update.filter((m) => !(m instanceof RemoveMessage));
  assert.equal(copies.length, 1);
  const copy = copies[0];
  // The copy carries the full announce text, lives in main (no lane), and keeps
  // only minimal provenance.
  assert.match(String(copy.content), /FULL_ANNOUNCE_MARKER/);
  assert.equal(getAgentMessageLane(copy), null);
  assert.match(readAgentMessageCreatedAt(copy) ?? '', /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.deepEqual(getMessageHandoffSource(copy), {
    handoffFrom: 'capability:explore',
    delegationId: 'd1',
    runId: 't1',
    task: '查动态',
    announceMessageId: 'm-announce',
  });
});

test('handoff idempotency is scoped by delegation lane and run id', () => {
  const oldCopy = new DelegationAnnounceMessage({
    id: 'stored-old-announce',
    sourceLane: 'capability:general',
    delegationId: 'same-delegation',
    runId: 'run-old',
    task: 'same task',
    announceMessageId: 'announce-old',
    completionReason: 'natural',
    result: 'old run result',
    createdAt: '2026-08-23T00:00:00.000Z',
  });
  const currentCopy = new DelegationAnnounceMessage({
    id: 'stored-current-announce',
    sourceLane: 'capability:general',
    delegationId: 'same-delegation',
    runId: 'run-current',
    task: 'same task',
    announceMessageId: 'announce-current',
    completionReason: 'natural',
    result: 'current run result',
    createdAt: '2026-08-23T00:00:00.000Z',
  });

  assert.equal(
    findLatestHandoffCopyForDelegation(
      [oldCopy, currentCopy],
      'same-delegation',
      'capability:general',
      'run-current',
      getMessageHandoffSource,
    ),
    currentCopy,
  );
  assert.equal(
    findLatestHandoffCopyForDelegation(
      [oldCopy, currentCopy],
      'same-delegation',
      'capability:general',
      'run-missing',
      getMessageHandoffSource,
    ),
    null,
  );
});

test('old handoff metadata is not treated as an accepted delegation result', () => {
  const oldCopy = new AIMessage('旧 handoff 文本');
  setAgentMessageMetadata(oldCopy, {
    handoffFrom: 'capability:general',
    delegationId: 'old-delegation',
    runId: 'old-run',
    task: '旧任务',
    announceMessageId: 'old-announce',
  });

  assert.equal(getDelegationAnnounce(oldCopy), null);
  assert.equal(getMessageHandoffSource(oldCopy), null);
});

test('buildSubagentHandoff retains only announce identity and result', () => {
  const userAsk = new HumanMessage('请帮我做一次探索');
  const announce = createPrivateAnnounce({
    id: 'm-announce-2',
    lane: 'capability:explore',
    runId: 'run-1',
    delegationId: 'd-announce',
    task: '探索任务',
    result: '已整理好探索结果。',
  });
  const update = buildSubagentHandoff({
    messages: [userAsk, announce],
    lane: 'capability:explore',
    runId: 'run-1',
    delegationId: 'd-announce',
  });
  assert.ok(update);
  const copy = update.find((message) => message instanceof AIMessage && message.id !== 'm-announce-2') as AIMessage;
  const typed = getDelegationAnnounce(copy);
  assert.ok(typed);
  assert.equal(String(copy.content), '已整理好探索结果。');
  assert.equal('artifactRefs' in typed, false);
  const source = getMessageHandoffSource(copy);
  assert.deepEqual(source, {
    handoffFrom: 'capability:explore',
    delegationId: 'd-announce',
    runId: 'run-1',
    task: '探索任务',
    announceMessageId: 'm-announce-2',
  });
});

test('buildSubagentHandoff keeps lane messages when clearLane is disabled', () => {
  const humanAsk = new HumanMessage('继续处理一些文件');
  const intermediate = new AIMessage('准备处理中...');
  intermediate.id = 'm-mid';
  setAgentMessageMetadata(intermediate, { lane: 'capability:general', runId: 'run-5', delegationId: 'd-keep' });
  const announce = createPrivateAnnounce({
    id: 'm-announce-keep',
    lane: 'capability:general',
    runId: 'run-5',
    delegationId: 'd-keep',
    task: '增量处理',
    result: '已完成部分，继续留痕。',
  });

  const update = buildSubagentHandoff({
    messages: [humanAsk, intermediate, announce],
    lane: 'capability:general',
    runId: 'run-5',
    delegationId: 'd-keep',
    clearLane: false,
  });
  assert.ok(update);
  const removed = update.filter((m) => m instanceof RemoveMessage);
  assert.equal(removed.length, 0);
  const copy = update.find((m) => m instanceof AIMessage && m.id !== 'm-announce-keep') as AIMessage | undefined;
  assert.ok(copy);
  assert.match(String(copy.content), /已完成部分，继续留痕。/);
  const source = getMessageHandoffSource(copy);
  assert.deepEqual(source, {
    handoffFrom: 'capability:general',
    delegationId: 'd-keep',
    runId: 'run-5',
    task: '增量处理',
    announceMessageId: 'm-announce-keep',
  });
});

test('buildSubagentHandoff returns null when the delegation has no announce text', () => {
  const intermediate = new AIMessage('只有中间步骤，没有结论');
  intermediate.id = 'm1';
  setAgentMessageMetadata(intermediate, { lane: 'capability:general', runId: 't1', delegationId: 'd1' });
  const update = buildSubagentHandoff({
    messages: [new HumanMessage('做点事'), intermediate],
    lane: 'capability:general',
    runId: 't1',
    delegationId: 'd1',
  });
  assert.equal(update, null);
});

test('buildSubagentHandoff rejects an announce without a message id', () => {
  const announce = createPrivateAnnounce({
    lane: 'capability:general',
    runId: 't1',
    delegationId: 'd1',
    result: '完成结果',
  });

  assert.throws(() => buildSubagentHandoff({
    messages: [announce],
    lane: 'capability:general',
    runId: 't1',
    delegationId: 'd1',
  }), /missing the required message id/);
});

test('terminal Planner action keeps active delegation when handoff cannot be built', async () => {
  let toolRunCount = 0;
  let answerMessages: BaseMessage[] = [];
  const rawTool = tool(async () => {
    toolRunCount += 1;
    return 'ran';
  }, {
    name: 'run_shell',
    description: 'run shell',
    schema: z.object({}),
  });
  const routeModel = {
    invoke: async (messages: unknown[]) => {
      answerMessages = messages as BaseMessage[];
      return new AIMessage('当前 delegated task 还没有可交接结果，暂不能完成任务边界切换。');
    },
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => taskDoneDecision('当前任务似乎完成，但没有可交接 announce。'),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
    maxRunIterations: 0,
  });
  const activeDelegation: TaskActiveDelegation = {
    id: 'active-1',
    lane: 'capability:explore',
    task: '当前 explore 任务',
    contextSummary: '已有任务仍待判断。',
    runId: 'run-active',
    traceId: 'trace-active',
    status: 'awaiting_decision',
    resultPreview: null,
    userRequest: '继续判断当前 explore 任务。',
  };
  const input = {
    ...buildOrchestratorRunInput([
      new HumanMessage('继续'),
      // No announce message for active-1: buildSubagentHandoff must return null.
      new AIMessage('只有中间步骤，没有可交接结果。'),
    ], { activeDelegationTransition: 'resume_active' }),
    taskActiveDelegation: activeDelegation,
  };
  input.runDelegationSummaries = [{
    id: 'active-1',
    lane: 'capability:explore',
    task: '当前 explore 任务',
    status: 'progress',
    resultPreview: null,
  }];

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'different-lane-replacement-blocked',
      actor: testActor,
      capabilities: [capability('explore', '探索 capability。')],
      toolkits: [{
        name: 'local',
        description: 'local tools',
        tools: toolDefinitions(rawTool),
      }],
    },
  }) as {
    messages: Array<AIMessage | HumanMessage>;
    runNextDelegation: unknown;
    taskActiveDelegation: TaskActiveDelegation | null;
    runDelegationSummaries: RunDelegationSummary[];
  };

  assert.equal(toolRunCount, 0);
  assert.equal(state.runNextDelegation, null);
  assert.equal(state.taskActiveDelegation?.id, 'active-1');
  assert.equal(state.taskActiveDelegation?.lane, 'capability:explore');
  assert.deepEqual(state.runDelegationSummaries.map((item) => item.id), ['active-1']);
  assert.doesNotMatch(String(answerMessages[0]?.content ?? ''), /当前 explore 任务|已有任务仍待判断/);
  assert.match(String(answerMessages.at(-1)?.content ?? ''), /<reply_mode>blocked<\/reply_mode>/);
  assert.match(String(answerMessages.at(-1)?.content ?? ''), /<blocked_reason meaning="[^"]+">capability_unavailable<\/blocked_reason>/);
  assert.match(String(answerMessages.at(-1)?.content ?? ''), /当前 explore 任务/);
  assert.match(String(mainConversationMessages(state.messages).at(-1)?.content ?? ''), /暂不能完成任务边界切换/);
});

test('Planner continue_current action can re-enter main and finalize handoff', async () => {
  const announceText = '已完成第一批抓取，接下来继续。';
  let routeCallCount = 0;
  const routeModel = {
    invoke: async () => new AIMessage(''),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        return routeCallCount === 1
          ? continueDecision('保留当前发现并往下推进。')
          : goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    actor: testActor,
  });
  const activeDelegation: TaskActiveDelegation = {
    id: 'active-continue',
    lane: 'capability:general',
    task: '批量梳理仓库问题',
    contextSummary: '已完成部分。',
    runId: 'run-continue',
    traceId: 'trace-continue',
    status: 'awaiting_decision',
    resultPreview: '已完成第一批抓取，剩余待查。',
    userRequest: '继续批量梳理仓库问题。',
  };
  const inputBase = buildOrchestratorRunInput(
    [new HumanMessage('继续处理仓库')],
    { activeDelegationTransition: 'resume_active' },
  );
  activeDelegation.runId = inputBase.runId;
  const input = {
    ...inputBase,
    taskActiveDelegation: activeDelegation,
  };
  input.runDelegationSummaries = [{
    id: activeDelegation.id,
    lane: activeDelegation.lane,
    task: activeDelegation.task,
    status: 'progress',
    resultPreview: activeDelegation.resultPreview,
  }];

  const previousAnnounce = createPrivateAnnounce({
    id: 'm-prev-announce',
    lane: 'capability:general',
    runId: input.runId,
    delegationId: activeDelegation.id,
    completionReason: 'natural',
    task: activeDelegation.task,
    result: announceText,
  });
  input.messages.push(previousAnnounce);

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'delegation-continue-copy-preserve-lane',
      actor: testActor,
      capabilities: [capability('general', 'General-purpose capability.', ['local'])],
      toolkits: [{
        name: 'local',
        description: 'local tools',
        tools: toolDefinitions(mockTool('run_shell')),
      }],
    },
  }) as OrchestratorStateType;

  const handoffSource = mainConversationMessages(state.messages)
    .map((message) => getMessageHandoffSource(message))
    .find((source) => source?.delegationId === activeDelegation.id);
  assert.ok(handoffSource);
  assert.equal(handoffSource.handoffFrom, 'capability:general');
  assert.equal(handoffSource.runId, input.runId);
  assert.equal(handoffSource.task, '批量梳理仓库问题');
  // Final handoff on answer should clear private messages for finished continuation.
  assert.equal(queryAgentMessages(state.messages).delegation({
    lane: 'capability:general',
    runId: input.runId,
    delegationId: activeDelegation.id,
  }).select().messages.filter(isTypedDelegationAnnounce).length, 0);
});

test('Planner continuation path rechecks run iteration guard before next decision', async () => {
  let routeCallCount = 0;
  const routeModel = {
    invoke: async () => new AIMessage('主流程循环已达到上限。'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        return routeCallCount === 1
          ? continueDecision('已经执行了一段进度，继续执行下一段。')
          : goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeListChatModel({ responses: ['已完成一段子任务。'], sleep: 0 }),
    },
    actor: testActor,
  });

  const activeDelegation: TaskActiveDelegation = {
    id: 'active-limit-inline',
    lane: 'capability:general',
    task: '执行长流程任务',
    contextSummary: '持续进行。',
    runId: 'run-continue-limit',
    traceId: 'trace-continue-limit',
    status: 'awaiting_decision',
    resultPreview: '进度已完成前段。',
    userRequest: '继续执行长流程任务。',
  };
  const inputBase = buildOrchestratorRunInput(
    [new HumanMessage('继续执行任务')],
    { activeDelegationTransition: 'resume_active' },
  );
  activeDelegation.runId = inputBase.runId;
  const input = {
    ...inputBase,
    taskActiveDelegation: activeDelegation,
    runDelegationSummaries: [{
      id: activeDelegation.id,
      lane: activeDelegation.lane,
      task: activeDelegation.task,
      status: 'progress',
      resultPreview: activeDelegation.resultPreview,
    }] as RunDelegationSummary[],
  };

  const announce = createPrivateAnnounce({
    id: 'm-limit-announce',
    lane: 'capability:general',
    runId: input.runId,
    delegationId: activeDelegation.id,
    completionReason: 'natural',
    task: activeDelegation.task,
    result: '进度已完成前段。',
  });
  input.messages.push(announce);

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'delegation-outcome-to-iteration-guard',
      actor: testActor,
      capabilities: [capability('general', 'General-purpose capability.', ['local'])],
      maxRunIterations: 1,
      toolkits: [{
        name: 'local',
        description: 'local tools',
        tools: toolDefinitions(mockTool('run_shell')),
      }],
    },
  }) as OrchestratorStateType;

  assert.equal(routeCallCount, 1);
  assert.equal(state.taskActiveDelegation?.id, activeDelegation.id);
  assert.equal(state.runIterationCount, 0);
  const finalText = String(state.messages.at(-1)?.content ?? '');
  assert.match(finalText, /主流程循环已达到上限/);
});

test('Planner boundary accepts each announce attempt once', async () => {
  let routeCallCount = 0;
  const plannerInputs: CapabilityPlannerInput[] = [];
  const routeModel = {
    invoke: async () => new AIMessage(''),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: new FakeListChatModel({
        responses: ['进度更新：已完成一部分，继续保留。', '进度更新：已完成一部分，继续保留。'],
        sleep: 0,
      }),
    },
    actor: testActor,
    capabilityPlannerRunner: {
      async invoke(plannerInput) {
        routeCallCount += 1;
        plannerInputs.push(plannerInput);
        return routeCallCount <= 2
          ? { action: 'continue_current', tasks: [] }
          : { action: 'goal_done', tasks: [] };
      },
    },
  });

  const activeDelegation: TaskActiveDelegation = {
    id: 'active-dup-copy',
    lane: 'capability:general',
    task: '处理大型清单',
    contextSummary: '尚未完成。',
    runId: 'run-dup-copy',
    traceId: 'trace-dup-copy',
    status: 'awaiting_decision',
    resultPreview: '进度更新：已完成一部分，继续保留。',
    userRequest: '继续处理大型清单。',
  };
  const inputBase = buildOrchestratorRunInput(
    [new HumanMessage('继续清单处理')],
    { activeDelegationTransition: 'resume_active' },
  );
  activeDelegation.runId = inputBase.runId;
  const input = {
    ...inputBase,
    taskActiveDelegation: activeDelegation,
    runDelegationSummaries: [{
      id: activeDelegation.id,
      lane: activeDelegation.lane,
      task: activeDelegation.task,
      status: 'progress',
      resultPreview: activeDelegation.resultPreview,
    }] as RunDelegationSummary[],
  };
  const initialAnnounce = createPrivateAnnounce({
    id: 'm-dup-copy',
    lane: 'capability:general',
    runId: input.runId,
    delegationId: activeDelegation.id,
    completionReason: 'natural',
    task: activeDelegation.task,
    result: '进度更新：已完成一部分，继续保留。',
  });
  input.messages.push(initialAnnounce);

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'delegation-outcome-no-duplicate-handoff',
      actor: testActor,
      capabilities: [capability('general', 'General-purpose capability.', ['local'])],
      maxRunIterations: 10,
      toolkits: [{
        name: 'local',
        description: 'local tools',
        tools: toolDefinitions(mockTool('run_shell')),
      }],
    },
  }) as OrchestratorStateType;

  assert.equal(routeCallCount, 3);
  assert.deepEqual(
    plannerInputs.map((plannerInput) =>
      plannerInput.announceAttempts.map((announce) => announce.messageId)),
    [
      ['m-dup-copy'],
      ['m-dup-copy', plannerInputs[1]?.latestAnnounce?.messageId],
      [
        'm-dup-copy',
        plannerInputs[1]?.latestAnnounce?.messageId,
        plannerInputs[2]?.latestAnnounce?.messageId,
      ],
    ],
  );
  assert.deepEqual(
    plannerInputs.map((plannerInput) => plannerInput.plannerSession.revision),
    [0, 1, 2],
  );
  assert.equal(new Set(plannerInputs.map((plannerInput) =>
    plannerInput.plannerSession.runId)).size, 1);
  for (const plannerInput of plannerInputs) {
    assert.equal(plannerInput.messages.some(isTypedDelegationAnnounce), false);
    assert.equal(
      plannerInput.latestAnnounce?.messageId,
      plannerInput.announceAttempts.at(-1)?.messageId,
    );
  }
  const handoffCopies = mainConversationMessages(state.messages)
    .filter((message) => {
      const source = getMessageHandoffSource(message);
      return source?.delegationId === activeDelegation.id;
    });
  assert.equal(handoffCopies.length, 3);
  assert.equal(new Set(handoffCopies.map((message) => message.id)).size, 3);
});

test('private reconciliation materializes one typed lane announce', () => {
  const messages = [
    new HumanMessage('帮我查一下公开资料'),
    new AIMessage({ id: 'task-1-announce', content: '已查到热门动态。' }),
  ];

  const tagged = reconcileDelegationPrivateMessages(messages, [messages[0]], 'capability:general', 'turn-1', 'natural', {
    delegationId: 'task-1',
    task: '查公开资料',
    announceMessageId: 'task-1-announce',
  });

  assert.equal(tagged.length, 1);
  // The runtime-selected deliverable becomes the typed announce (neutral, no verdict).
  assert.equal(isTypedDelegationAnnounce(tagged[0] as BaseMessage), true);
  assert.equal(getAgentMessageDelegationId(messages[1]), 'task-1');
  assert.deepEqual(mainConversationMessages(messages).map((message) => message.content), ['帮我查一下公开资料']);
  assert.deepEqual(selectCapabilityHistory(messages, 'capability:general', 'turn-1', 'task-1').map((message) => message.content), [
    '帮我查一下公开资料',
    '已查到热门动态。',
  ]);
  assert.deepEqual(readLatestAnnounce(tagged, {
    lane: 'capability:general',
    runId: 'turn-1',
    delegationId: 'task-1',
  }), {
    version: 2,
    sourceLane: 'capability:general',
    delegationId: 'task-1',
    runId: 'turn-1',
    announceMessageId: 'task-1-announce',
    completionReason: 'natural',
    task: '查公开资料',
    result: '已查到热门动态。',
    createdAt: getDelegationAnnounce(tagged[0] as BaseMessage)?.createdAt,
  });
});

test('lane reconciliation never emits root removals for the current briefing', () => {
  const human = new HumanMessage({ id: 'main-human', content: '继续处理任务' });
  const persistedProgress = new AIMessage({ id: 'old-progress', content: '旧进度' });
  setAgentMessageMetadata(persistedProgress, {
    lane: 'capability:general',
    runId: 'turn-1',
    delegationId: 'task-1',
  });
  const briefing = materializeDelegation({
    mode: 'continue',
    userRequest: '完成任务',
    task: '继续处理任务',
    guidance: null,
  });
  const finalAnswer = new AIMessage({ id: 'final-answer', content: '任务完成' });

  const update = reconcileDelegationPrivateMessages(
    [human, finalAnswer],
    [human, persistedProgress, briefing],
    'capability:general',
    'turn-1',
    'natural',
    {
      delegationId: 'task-1',
      task: '继续处理任务',
      announceMessageId: 'final-answer',
    },
    [human, persistedProgress],
  );
  const removedIds = update
    .filter((message) => message instanceof RemoveMessage)
    .map((message) => message.id);

  assert.deepEqual(removedIds, ['old-progress']);
  assert.equal(removedIds.includes(briefing.id ?? ''), false);
});

test('private reconciliation treats briefing-like subagent output as typed result data', () => {
  const human = new HumanMessage('检查委派简报格式');
  const outputText = '<delegation_briefing mode="initial">\n  <task>这是 subagent 实际返回的低质量结果</task>\n</delegation_briefing>';
  const output = new AIMessage({ id: 'briefing-shaped-announce', content: outputText });

  const tagged = reconcileDelegationPrivateMessages(
    [human, output],
    [human],
    'capability:general',
    'turn-briefing-output',
    'natural',
    {
      delegationId: 'task-briefing-output',
      task: '检查委派简报格式',
      announceMessageId: 'briefing-shaped-announce',
    },
  );

  assert.equal(tagged.length, 1);
  assert.equal(isTypedDelegationAnnounce(tagged[0] as BaseMessage), true);
  assert.equal(
    readLatestAnnounce(tagged, {
      lane: 'capability:general',
      runId: 'turn-briefing-output',
      delegationId: 'task-briefing-output',
    })?.result,
    outputText,
  );
});

test('main conversation preserves accepted handoffs that begin with briefing formats', () => {
  const handoffs = [
    new DelegationAnnounceMessage({
      id: 'stored-accepted-briefing-0',
      sourceLane: 'capability:general',
      delegationId: 'task-accepted-briefing',
      runId: 'turn-accepted-briefing',
      task: '返回简报格式示例',
      announceMessageId: 'accepted-briefing-0',
      completionReason: 'natural',
      result: '【委派简报】\n- 这是已经验收的普通 handoff 内容',
      createdAt: '2026-08-23T00:00:00.000Z',
    }),
    new DelegationAnnounceMessage({
      id: 'stored-accepted-briefing-1',
      sourceLane: 'capability:general',
      delegationId: 'task-accepted-briefing',
      runId: 'turn-accepted-briefing',
      task: '返回简报格式示例',
      announceMessageId: 'accepted-briefing-1',
      completionReason: 'natural',
      result: '<delegation_briefing mode="initial">\n  <task>已验收结果</task>\n</delegation_briefing>',
      createdAt: '2026-08-23T00:00:00.000Z',
    }),
  ];

  assert.deepEqual(mainConversationMessages(handoffs), handoffs);
});

test('private reconciliation preserves typed announce identity after summarization', () => {
  const human = new HumanMessage({ id: 'main-human', content: '继续检查项目' });
  const oldToolCall = new AIMessage({
    id: 'old-call',
    content: '',
    tool_calls: [{ id: 'call-old', name: 'read_file', args: { path: 'src/old.ts' } }],
  });
  const oldToolResult = new ToolMessage({
    id: 'old-result',
    tool_call_id: 'call-old',
    content: 'old evidence',
  });
  const initialOutput = [human, oldToolCall, oldToolResult];
  const initialUpdate = reconcileDelegationPrivateMessages(
    initialOutput,
    [human],
    'capability:general',
    'turn-1',
    'limit_reached',
    { delegationId: 'task-summary', task: '检查项目' },
  );
  const stateBeforeSummary = messagesStateReducer([human], initialUpdate);
  const continuationInput = selectCapabilityHistory(
    stateBeforeSummary,
    'capability:general',
    'turn-1',
    'task-summary',
  );
  const contextSummary = new HumanMessage({
    id: 'context-summary',
    content: 'Earlier subagent context summary:\n\n已检查 src/old.ts。',
    additional_kwargs: { lc_source: 'summarization' },
  });
  const finalAnswer = new AIMessage({ id: 'final-answer', content: '检查完成。' });

  const summarizedUpdate = reconcileDelegationPrivateMessages(
    [contextSummary, finalAnswer],
    continuationInput,
    'capability:general',
    'turn-1',
    'natural',
    {
      delegationId: 'task-summary',
      task: '检查项目',
      announceMessageId: 'final-answer',
    },
  );
  const stateAfterSummary = messagesStateReducer(stateBeforeSummary, summarizedUpdate);

  assert.equal(stateAfterSummary.some((message) => message.id === 'main-human'), true);
  assert.equal(stateAfterSummary.some((message) => message.id === 'old-call'), false);
  assert.equal(stateAfterSummary.some((message) => message.id === 'old-result'), false);
  assert.equal(getAgentMessageLane(contextSummary), 'capability:general');
  assert.equal(getAgentMessageDelegationId(contextSummary), 'task-summary');
  assert.equal(isTypedDelegationAnnounce(
    stateAfterSummary.find((message) => message.id === 'final-answer') as BaseMessage,
  ), true);
  assert.deepEqual(
    selectCapabilityHistory(stateAfterSummary, 'capability:general', 'turn-1', 'task-summary').map((message) => message.id),
    ['main-human', 'context-summary', 'final-answer'],
  );
});

test('private reconciliation materializes the typed announce regardless of stop reason', () => {
  const messages = [
    new HumanMessage('读取文件并运行 lint'),
    new AIMessage({ id: 'task-2-progress', content: '文件读取完成，lint 还没跑。' }),
  ];

  // limit_reached is just a stop reason; the selected deliverable still becomes
  // an Announce without adding a completed/progress verdict.
  const tagged = reconcileDelegationPrivateMessages(messages, [messages[0]], 'capability:general', 'turn-1', 'limit_reached', {
    delegationId: 'task-2',
    task: '读取文件并运行 lint',
    announceMessageId: 'task-2-progress',
  });

  const typedProgress = tagged[0] as BaseMessage;
  assert.equal(isTypedDelegationAnnounce(typedProgress), true);
  assert.deepEqual(readLatestAnnounce(tagged, {
    lane: 'capability:general',
    runId: 'turn-1',
    delegationId: 'task-2',
  }), {
    version: 2,
    sourceLane: 'capability:general',
    delegationId: 'task-2',
    runId: 'turn-1',
    announceMessageId: 'task-2-progress',
    completionReason: 'limit_reached',
    task: '读取文件并运行 lint',
    result: '文件读取完成，lint 还没跑。',
    createdAt: getDelegationAnnounce(typedProgress)?.createdAt,
  });
  assert.equal(selectDelegationAnnounceMessage(tagged, {
    lane: 'capability:general',
    runId: 'turn-1',
    delegationId: 'task-2',
    announceMessageId: 'task-2-progress',
  }), typedProgress);
  assert.equal(selectDelegationAnnounceMessage(tagged, {
    lane: 'capability:general',
    runId: 'turn-1',
    delegationId: 'task-2',
    announceMessageId: 'another-message',
  }), null);
});

test('limit-reached subagent announce reaches the Planner boundary input', async () => {
  const baseInput = buildOrchestratorRunInput(
    [new HumanMessage('继续探查 repo')],
    { activeDelegationTransition: 'resume_active' },
  );
  const progress = new AIMessage({
    id: 'limit-chain-progress',
    content: '已完成依赖检查，剩余源码还需要继续探查。',
  });
  let progressInjected = false;
  const progressMiddleware = createMiddleware({
    name: 'LimitChainProgressProbe',
    beforeModel: () => {
      if (progressInjected) return;
      progressInjected = true;
      return { messages: [progress] };
    },
  });
  const noop = tool(async () => 'ok', {
    name: 'noop',
    description: 'no-op',
    schema: z.object({}),
  });
  const result = await createSubagent({
    model: new FakeToolCallingModel({
      toolCalls: [[{ id: 'limit-chain-call', name: 'noop', args: {} }]],
    }),
    tools: [noop],
    middleware: [progressMiddleware],
    promptSections: [],
    messages: baseInput.messages,
    maxIterations: 1,
  });

  assert.equal(result.completionReason, 'limit_reached');
  assert.equal(result.announceMessageId, progress.id);
  const delegationId = 'limit-chain-delegation';
  const tagged = reconcileDelegationPrivateMessages(
    result.messages,
    baseInput.messages,
    'capability:general',
    baseInput.runId,
    result.completionReason,
    {
      delegationId,
      task: '继续探查 repo',
      announceMessageId: result.announceMessageId,
    },
  );
  const messages = messagesStateReducer(baseInput.messages, tagged);
  const taggedProgress = messages.find((message) => message.id === progress.id);
  assert.ok(taggedProgress);
  assert.equal(isTypedDelegationAnnounce(taggedProgress), true);
  assert.equal(getDelegationAnnounce(taggedProgress)?.completionReason, 'limit_reached');

  let plannerInput: CapabilityPlannerInput | null = null;
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({ invoke: async () => goalDoneDecision() }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: { act: routeModel, observe: routeModel },
    actor: testActor,
    capabilityPlannerRunner: {
      async invoke(input) {
        plannerInput = input;
        return {
          action: 'user_input_required',
          tasks: [],
          userInputRequest: { question: '是否继续探查当前仓库？' },
        };
      },
    },
  });
  const activeDelegation: TaskActiveDelegation = {
    id: delegationId,
    lane: 'capability:general',
    task: '继续探查 repo',
    contextSummary: null,
    runId: baseInput.runId,
    traceId: baseInput.traceId,
    status: 'awaiting_decision',
    resultPreview: String(progress.content),
    userRequest: '继续探查 repo。',
  };

  await graph.invoke({
    ...baseInput,
    messages,
    taskActiveDelegation: activeDelegation,
    runDelegationSummaries: [{
      id: delegationId,
      lane: 'capability:general',
      task: activeDelegation.task,
      status: 'progress',
      resultPreview: activeDelegation.resultPreview,
    }],
  }, {
    configurable: {
      thread_id: 'limit-chain-outcome-input',
      actor: testActor,
      capabilities: [],
      toolkits: [],
    },
  });

  const observedPlannerInput = plannerInput as CapabilityPlannerInput | null;
  assert.equal(observedPlannerInput?.mode, 'boundary');
  assert.equal(observedPlannerInput?.latestAnnounce?.completionReason, 'limit_reached');
  assert.match(
    observedPlannerInput?.announceAttempts[0]?.result ?? '',
    /已完成依赖检查，剩余源码还需要继续探查。/,
  );
});

test('Planner boundary does not handoff a limit_reached announce', async () => {
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => goalDoneDecision(),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
    },
    actor: testActor,
  });
  const baseInput = buildOrchestratorRunInput(
    [new HumanMessage('继续')],
    { activeDelegationTransition: 'resume_active' },
  );

  const activeDelegation: TaskActiveDelegation = {
    id: 'limit-active',
    lane: 'capability:general',
    task: '继续探查 repo',
    contextSummary: null,
    runId: baseInput.runId,
    traceId: baseInput.traceId,
    status: 'awaiting_decision',
    resultPreview: '上一轮还没结束。',
    userRequest: '继续探查 repo。',
  };
  const input = {
    ...baseInput,
    taskActiveDelegation: activeDelegation,
    runDelegationSummaries: [{
      id: activeDelegation.id,
      lane: activeDelegation.lane,
      task: activeDelegation.task,
      status: 'progress' as const,
      resultPreview: activeDelegation.resultPreview,
    }],
  };
  const partialAnnounce = createPrivateAnnounce({
    lane: 'capability:general',
    runId: input.runId,
    delegationId: activeDelegation.id,
    completionReason: 'limit_reached',
    task: activeDelegation.task,
    result: '已跑到一半，继续需要更多时间。',
  });

  input.messages.push(partialAnnounce);

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'limit-announce-no-handoff',
      actor: testActor,
      capabilities: [],
      toolkits: [{
        name: 'local',
        description: 'local tools',
        tools: toolDefinitions(mockTool('run_shell')),
      }],
  } }) as OrchestratorStateType;

  const handoffMessages = mainConversationMessages(state.messages)
    .filter((message) => getMessageHandoffSource(message)?.handoffFrom);
  assert.equal(handoffMessages.length, 0);
  assert.equal(state.taskActiveDelegation?.id, activeDelegation.id);
  assert.equal(state.taskActiveDelegation?.status, 'awaiting_decision');
  assert.equal(state.runDelegationSummaries.find((item) => item.id === activeDelegation.id)?.status, 'progress');
  assert.equal(state.messages.filter(
    (message) => getAgentMessageLane(message) === 'capability:general',
  ).length > 0, true);
});

test('Planner boundary uses a unified run-iteration guard before invoking decision', async () => {
  let answerMessages: BaseMessage[] = [];
  const routeModel = {
    invoke: async (messages: unknown[]) => {
      answerMessages = messages as BaseMessage[];
      return new AIMessage('主流程循环已达到上限，当前任务仍可续跑。');
    },
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        assert.fail('delegation decision should not run after run-iteration limit');
      },
    }),
  } as unknown as AgentModels['act'];

  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
    },
    actor: testActor,
    maxRunIterations: 2,
  });
  const baseInput = buildOrchestratorRunInput(
    [new HumanMessage('继续')],
    { activeDelegationTransition: 'resume_active' },
  );
  const input = {
    ...baseInput,
    taskActiveDelegation: null as TaskActiveDelegation | null,
    runDelegationSummaries: [] as RunDelegationSummary[],
  };
  input.runIterationCount = 2;
  const activeDelegation: TaskActiveDelegation = {
    id: 'limit-iter',
    lane: 'capability:general',
    task: '持续执行大规模迁移',
    contextSummary: '最近卡住',
    runId: baseInput.runId,
    traceId: baseInput.traceId,
    status: 'awaiting_decision',
    resultPreview: '处理到一半。',
    userRequest: '完成大规模迁移。',
  };
  const partialAnnounce = createPrivateAnnounce({
    lane: 'capability:general',
    runId: input.runId,
    delegationId: activeDelegation.id,
    completionReason: 'natural',
    task: activeDelegation.task,
    result: '继续迁移，已完成 50%。',
  });

  input.messages.push(partialAnnounce);
  input.taskActiveDelegation = activeDelegation;
  input.runDelegationSummaries = [{
    id: activeDelegation.id,
    lane: activeDelegation.lane,
    task: activeDelegation.task,
    status: 'progress' as const,
    resultPreview: activeDelegation.resultPreview,
  }];

  const state = await graph.invoke(input, {
    configurable: {
      thread_id: 'unified-run-iteration-limit',
      actor: testActor,
      capabilities: [],
      toolkits: [{
        name: 'local',
        description: 'local tools',
        tools: toolDefinitions(mockTool('run_shell')),
      }],
    },
  }) as OrchestratorStateType;

  assert.doesNotMatch(String(answerMessages[0]?.content ?? ''), /持续执行大规模迁移|最近卡住/);
  assert.match(String(answerMessages.at(-1)?.content ?? ''), /<reply_mode>blocked<\/reply_mode>/);
  assert.match(String(answerMessages.at(-1)?.content ?? ''), /<blocked_reason meaning="[^"]+">iteration_limit<\/blocked_reason>/);
  assert.match(String(answerMessages.at(-1)?.content ?? ''), /持续执行大规模迁移/);
  assert.equal(state.messages.at(-1)?.content?.toString().includes('主流程循环已达到上限'), true);
  assert.equal(state.runIterationCount, 0);
  assert.equal(state.taskActiveDelegation?.id, activeDelegation.id);
});

test('handoff copies the announce into main and wipes the private messages', () => {
  const human = new HumanMessage('检查项目并汇报');
  const toolCall = new AIMessage({
    content: '先读取 package.json。',
    tool_calls: [{ id: 'call-read', name: 'read_file', args: { path: 'package.json' } }],
  });
  const toolResult = new ToolMessage({
    content: '{"scripts":{"test":"node --test"}}',
    tool_call_id: 'call-read',
  });
  const note = new AIMessage('已经确认测试脚本。');
  const announce = new AIMessage({
    id: 'task-complete-announce',
    content: '检查完成，测试脚本是 node --test。',
  });
  const outputMessages = [human, toolCall, toolResult, note, announce];

  const tagged = reconcileDelegationPrivateMessages(
    outputMessages,
    [human],
    'capability:general',
    'turn-1',
    'natural',
    {
    delegationId: 'task-complete',
    task: '检查项目并汇报',
    announceMessageId: 'task-complete-announce',
  });
  const stateWithLane = messagesStateReducer([human], tagged);

  const handoff = buildSubagentHandoff({
    messages: stateWithLane,
    lane: 'capability:general',
    runId: 'turn-1',
    delegationId: 'task-complete',
  });
  assert.ok(handoff);
  const stateMessages = messagesStateReducer(stateWithLane, handoff);

  // The private messages is gone; only the user message and a main-queue copy of
  // the announce remain.
  assert.deepEqual(stateMessages.map((message) => message.content), [
    '检查项目并汇报',
    '检查完成，测试脚本是 node --test。',
  ]);
  // The copy is a first-class main message (no lane) with handoff provenance.
  assert.equal(getAgentMessageLane(stateMessages[1]), null);
  assert.deepEqual(getMessageHandoffSource(stateMessages[1]), {
    handoffFrom: 'capability:general',
    delegationId: 'task-complete',
    runId: 'turn-1',
    task: '检查项目并汇报',
    announceMessageId: 'task-complete-announce',
  });
  // No lane-tagged messages for this delegation remain.
  assert.equal(stateMessages.filter(
    (message) => getAgentMessageLane(message) === 'capability:general',
  ).length, 0);
});

test('handoff after a resumed delegation wipes the whole delegation lane including old progress', () => {
  const human = new HumanMessage('处理所有分片');
  const oldToolCall = new AIMessage({
    content: '处理第一个分片。',
    tool_calls: [{ id: 'call-old', name: 'process_next_chunk', args: { source: 'items.csv' } }],
  });
  const oldToolResult = new ToolMessage({
    content: '第一个分片完成，还有剩余。',
    tool_call_id: 'call-old',
  });
  const oldProgress = new AIMessage({ id: 'task-resume-progress', content: '已处理第一个分片，尚未完成。' });
  const previousRun = [human, oldToolCall, oldToolResult, oldProgress];
  // First (interrupted) run keeps its whole lane in place — no handoff yet.
  const previousUpdate = reconcileDelegationPrivateMessages(
    previousRun,
    [human],
    'capability:general',
    'turn-1',
    'limit_reached',
    {
    delegationId: 'task-resume',
    task: '处理所有分片',
    announceMessageId: 'task-resume-progress',
  });
  const stateWithProgress = messagesStateReducer([human], previousUpdate);
  assert.equal(
    selectCapabilityHistory(stateWithProgress, 'capability:general', 'turn-1', 'task-resume').length,
    4,
  );

  // Continuation (same delegationId) completes naturally.
  const finalNote = new AIMessage('继续处理剩余分片。');
  const completedAnnounce = new AIMessage({
    id: 'task-resume-complete',
    content: '全部分片已处理完成，共 120 条。',
  });
  const continuationInput = selectCapabilityHistory(
    stateWithProgress,
    'capability:general',
    'turn-1',
    'task-resume',
  );
  const continuationOutput = [
    ...continuationInput,
    finalNote,
    completedAnnounce,
  ];
  const taggedContinuation = reconcileDelegationPrivateMessages(
    continuationOutput,
    continuationInput,
    'capability:general',
    'turn-1',
    'natural',
    {
      delegationId: 'task-resume',
      task: '处理所有分片',
      announceMessageId: 'task-resume-complete',
    },
  );
  const stateBeforeHandoff = messagesStateReducer(stateWithProgress, taggedContinuation);

  const handoff = buildSubagentHandoff({
    messages: stateBeforeHandoff,
    lane: 'capability:general',
    runId: 'turn-1',
    delegationId: 'task-resume',
  });
  assert.ok(handoff);
  const finalState = messagesStateReducer(stateBeforeHandoff, handoff);

  // The entire delegation lane (old progress + continuation messages) is gone;
  // only the user message and the main-queue copy of the final announce remain.
  assert.equal(finalState.filter(
    (message) => getAgentMessageLane(message) === 'capability:general',
  ).length, 0);
  assert.deepEqual(mainConversationMessages(finalState).map((m) => m.content), [
    '处理所有分片',
    '已处理第一个分片，尚未完成。',
    '全部分片已处理完成，共 120 条。',
  ]);
});

test('lane messages drop unanswered tool calls from interrupted subagent history', () => {
  const human = new HumanMessage('归档 Downloads');
  const completeToolCall = new AIMessage({
    content: '先检查目标目录。',
    tool_calls: [{ id: 'call-1', name: 'stat_path', args: { path: '/tmp' } }],
  });
  const toolResult = new ToolMessage({
    content: '{"ok":true}',
    tool_call_id: 'call-1',
  });
  const unansweredToolCall = new AIMessage({
    content: '继续移动文件。',
    tool_calls: [{ id: 'call-2', name: 'move_path', args: { source: 'a', destination: 'b' } }],
  });
  const messages = [human, completeToolCall, toolResult, unansweredToolCall];

  const tagged = reconcileDelegationPrivateMessages(
    messages,
    [human],
    'capability:general',
    'turn-1',
    'limit_reached',
    {
    delegationId: 'task-3',
    task: '归档 Downloads',
  });
  const stateMessages = [human, ...tagged];

  assert.deepEqual(stateMessages.map((message) => message.content), [
    '归档 Downloads',
    '先检查目标目录。',
    '{"ok":true}',
  ]);
  assert.equal(isTypedDelegationAnnounce(toolResult), false);
  assert.equal(readLatestAnnounce(stateMessages, {
    lane: 'capability:general',
    runId: 'turn-1',
    delegationId: 'task-3',
  }), null);
});

test('lane messages sanitize checkpoint history with dangling tool calls', () => {
  const human = new HumanMessage('继续归档');
  const danglingToolCall = new AIMessage({
    content: '准备移动。',
    tool_calls: [{ id: 'call-legacy', name: 'move_path', args: { source: 'a', destination: 'b' } }],
  });
  setAgentMessageMetadata(danglingToolCall, { lane: 'capability:general', runId: 'turn-1', delegationId: 'task-legacy' });

  assert.deepEqual(selectCapabilityHistory(
    [human, danglingToolCall],
    'capability:general',
    'turn-1',
    'task-legacy',
  ).map((message) => message.content), [
    '继续归档',
  ]);
});

test('lane messages scope to delegation: new task starts clean, reused id carries over', () => {
  const human = new HumanMessage('帮我整理仓库');
  const task1ToolCall = new AIMessage({
    content: '先看一下目录。',
    tool_calls: [{ id: 'call-t1', name: 'list_dir', args: { path: '.' } }],
  });
  const task1ToolResult = new ToolMessage({
    content: '{"entries":["a.ts"]}',
    tool_call_id: 'call-t1',
  });
  const task1Answer = new AIMessage({ id: 'task-1-answer', content: '目录已整理完成。' });
  const messages = [human, task1ToolCall, task1ToolResult, task1Answer];

  reconcileDelegationPrivateMessages(messages, [human], 'capability:general', 'turn-1', 'natural', {
    delegationId: 'task-1',
    task: '整理仓库',
    announceMessageId: 'task-1-answer',
  });

  // 同 turn 同 lane 的新 task：看不到上一个 task 的 private messages，只剩主对话。
  assert.deepEqual(selectCapabilityHistory(messages, 'capability:general', 'turn-1', 'task-2').map((message) => message.content), [
    '帮我整理仓库',
  ]);

  // 同一 delegation 续跑（复用 delegationId）：全量带回自己的 private messages。
  assert.deepEqual(selectCapabilityHistory(messages, 'capability:general', 'turn-1', 'task-1').map((message) => message.content), [
    '帮我整理仓库',
    '先看一下目录。',
    '{"entries":["a.ts"]}',
    '目录已整理完成。',
  ]);
});

test('lane messages reject lane history without a delegationId', () => {
  const human = new HumanMessage('继续');
  const invalidLaneMessage = new AIMessage('缺少 delegationId 的 lane 消息。');
  setAgentMessageMetadata(invalidLaneMessage, { lane: 'capability:general', runId: 'turn-1' });

  assert.throws(
    () => selectCapabilityHistory([human, invalidLaneMessage], 'capability:general', 'turn-1', 'task-1'),
    /missing delegationId/,
  );
});

test('delegation helpers keep new same-lane tasks separate and resume by explicit id', () => {
  const delegations: RunDelegationSummary[] = [
    {
      id: 'task-1',
      lane: 'capability:general',
      task: '读取文件',
      status: 'progress',
      resultPreview: '已读取部分文件',
    },
  ];

  const appended = appendRunDelegationSummary(delegations, {
    id: 'task-2',
    lane: 'capability:general',
    mode: 'initial',
    task: '运行 lint',
    contextSummary: '这是同一 lane 的新任务。',
  });

  assert.deepEqual(appended.map((item) => item.id), ['task-1', 'task-2']);
  assert.equal(appended[0].task, '读取文件');
  assert.equal(appended[0].status, 'progress');
  assert.equal(appended[1].task, '运行 lint');
  assert.equal(appended[1].status, 'pending');

  const resumed = resumeRunDelegationSummary(appended, {
    id: 'task-1',
    lane: 'capability:general',
    mode: 'continue',
    task: '读取文件',
    contextSummary: '继续原任务。',
  });
  assert.equal(resumed[0].status, 'pending');
  assert.equal(resumed[0].resultPreview, null);
  assert.equal(resumed[1].status, 'pending');
  assert.equal(resumed[1].task, '运行 lint');

  const completed = updateRunDelegationSummaryResult(resumed, 'task-1', {
    status: 'completed',
    resultPreview: '任务完成',
  });
  assert.equal(completed[0].status, 'completed');
  assert.equal(completed[0].resultPreview, '任务完成');
});

/**
 * Record the exact message arrays the subagent chat model receives. The fake
 * decision models are plain objects (not runnables), so handleChatModelStart
 * fires only for the real subagent FakeListChatModel.
 */
function createSubagentInputRecorder() {
  const subagentInputs: BaseMessage[][] = [];
  return {
    subagentInputs,
    callbacks: [{
      handleChatModelStart: (_llm: unknown, messages: BaseMessage[][]) => {
        subagentInputs.push(...messages);
      },
    }],
  };
}

function interruptedLaneMessages(params: {
  delegationId: string;
  runId: string;
  lane?: `capability:${string}`;
}) {
  const lane = params.lane ?? 'capability:general';
  const toolCall = new AIMessage({
    id: `${params.delegationId}-tool-call`,
    content: '旧任务正在执行工具。',
    tool_calls: [{
      id: `${params.delegationId}-call`,
      name: 'old_tool',
      args: {},
    }],
  });
  const toolResult = new ToolMessage({
    id: `${params.delegationId}-tool-result`,
    content: 'OLD_DELEGATION_TOOL_RESULT',
    tool_call_id: `${params.delegationId}-call`,
  });
  for (const message of [toolCall, toolResult]) {
    setAgentMessageMetadata(message, {
      lane,
      runId: params.runId,
      delegationId: params.delegationId,
    });
  }
  return [toolCall, toolResult];
}

test('fresh-turn active delegation transitions are explicit for pending and awaiting states', () => {
  const noActiveDelegation = {
    ...buildOrchestratorRunInput(
      [new HumanMessage('没有挂起任务时继续')],
      { activeDelegationTransition: 'resume_active' },
    ),
    taskActiveDelegation: null,
  } as OrchestratorStateType;
  assert.deepEqual(
    applyActiveDelegationTransition(noActiveDelegation),
    {},
  );

  for (const status of ['pending', 'awaiting_decision'] as const) {
    const activeDelegation: TaskActiveDelegation = {
      id: `old-${status}`,
      lane: 'capability:general',
      task: `旧的 ${status} 任务`,
      contextSummary: '旧任务上下文。',
      runId: `old-run-${status}`,
      traceId: `old-trace-${status}`,
      status,
      resultPreview: status === 'awaiting_decision' ? '旧进度。' : null,
      userRequest: '完成旧的仓库检查。\n\n保留原任务目标。',
    };
    const oldLaneMessages = interruptedLaneMessages({
      delegationId: activeDelegation.id,
      runId: activeDelegation.runId,
    });
    const supersedeState = {
      ...buildOrchestratorRunInput([new HumanMessage('开始全新的请求')]),
      messages: oldLaneMessages,
      taskActiveDelegation: activeDelegation,
    } as OrchestratorStateType;
    const supersedeUpdate = applyActiveDelegationTransition(supersedeState);

    assert.equal(supersedeUpdate.taskActiveDelegation, null);
    assert.equal(supersedeUpdate.messages, undefined);
    assert.deepEqual(supersedeState.messages, oldLaneMessages);

    const resumeState = {
      ...supersedeState,
      ...buildOrchestratorRunInput(
        [new HumanMessage('按我刚补充的方向继续')],
        { activeDelegationTransition: 'resume_active' },
      ),
      messages: [...oldLaneMessages, new HumanMessage('按我刚补充的方向继续')],
      taskActiveDelegation: activeDelegation,
    } as OrchestratorStateType;
    const resumeUpdate = applyActiveDelegationTransition(resumeState);
    assert.deepEqual(resumeUpdate.runUserRequest, activeDelegation.userRequest);
    assert.notEqual(resumeState.runId, activeDelegation.runId);
    const resumedState = {
      ...resumeState,
      ...resumeUpdate,
      messages: messagesStateReducer(
        resumeState.messages,
        resumeUpdate.messages ?? [],
      ),
    } as OrchestratorStateType;

    assert.equal(resumedState.taskActiveDelegation?.id, activeDelegation.id);
    assert.equal(
      resumedState.taskActiveDelegation?.runId,
      activeDelegation.runId,
    );
    assert.equal(
      selectCapabilityHistory(
        resumedState.messages,
        activeDelegation.lane,
        activeDelegation.runId,
        activeDelegation.id,
      ).some((message) => message instanceof ToolMessage),
      true,
    );
    assert.equal(
      selectCapabilityHistory(
        resumedState.messages,
        activeDelegation.lane,
        resumeState.runId,
        activeDelegation.id,
      ).some((message) => message instanceof ToolMessage),
      false,
    );
    if (status === 'pending') {
      assert.equal(resumedState.runNextDelegation?.id, activeDelegation.id);
      assert.equal(resumedState.runNextDelegation?.mode, 'continue');
      assert.equal(
        resumedState.runNextDelegation?.contextSummary,
        '按我刚补充的方向继续',
      );
      assert.equal(afterContextPrep(resumedState), 'capability');
      assert.equal(resumedState.messages.some(isDelegationBriefingMessage), false);
    } else {
      assert.equal(resumedState.runNextDelegation, null);
      assert.equal(afterContextPrep(resumedState), 'plannerBoundaryIterationGuard');
      assert.equal(resumedState.runDelegationSummaries[0]?.status, 'progress');
    }
  }
});

test('resume rejects a delegation without the current trace identity', () => {
  const legacyDelegation = {
    id: 'legacy-without-trace',
    lane: 'capability:general',
    task: '继续旧任务',
    contextSummary: null,
    runId: 'legacy-delegation-run',
    status: 'pending',
    resultPreview: null,
    userRequest: '继续旧任务。',
  } as unknown as TaskActiveDelegation;
  const state = {
    ...buildOrchestratorRunInput(
      [new HumanMessage('继续')],
      { activeDelegationTransition: 'resume_active' },
    ),
    taskActiveDelegation: legacyDelegation,
  } as OrchestratorStateType;

  assert.deepEqual(applyActiveDelegationTransition(state), {
    runNextDelegation: null,
    runPlannerSession: null,
    taskPlannerContinuation: null,
    runLatestDelegationOutcome: null,
    runRuntimeFailure: 'checkpoint_incompatible',
  });
});

test('fresh delegated request supersedes checkpointed work without deleting its lane', async () => {
  const oldDelegation: TaskActiveDelegation = {
    id: 'old-awaiting-delegation',
    lane: 'capability:general',
    task: '旧任务：检查历史 review 状态',
    contextSummary: '这段上下文不得进入新任务。',
    runId: 'old-awaiting-run',
    traceId: 'old-awaiting-trace',
    status: 'awaiting_decision',
    resultPreview: '旧任务执行了一部分。',
    userRequest: '检查历史 review 状态。',
  };
  const oldMessages: BaseMessage[] = interruptedLaneMessages({
    delegationId: oldDelegation.id,
    runId: oldDelegation.runId,
  });
  let structuredCallCount = 0;
  let executedDelegation: { delegationId: string; runId: string } | null = null;
  const actModel = {
    invoke: async () => new AIMessage('新请求已经完成。'),
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
    withStructuredOutput: () => ({
      invoke: async () => {
        structuredCallCount += 1;
        if (structuredCallCount === 1) {
          return scriptedPlannerTask('执行全新的请求。');
        }
        if (structuredCallCount === 2) {
          return scriptedPlannerCapability('general');
        }
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const freshCapability: AgentCapability = {
    ...capability('general', 'General-purpose capability.'),
    lifecycle: {
      finalize: (_result, context) => {
        executedDelegation = {
          delegationId: context.delegationId,
          runId: context.runId,
        };
      },
    },
  };
  const recorder = createSubagentInputRecorder();
  const graph = createOrchestratorGraph({
    models: {
      act: actModel,
      observe: actModel,
      subagent: new FakeListChatModel({
        responses: ['全新请求的执行结果。'],
        sleep: 0,
      }),
    },
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const config = {
    configurable: {
      thread_id: 'fresh-turn-supersedes-checkpointed-awaiting',
      actor: testActor,
      capabilities: [freshCapability],
      toolkits: [],
    },
    callbacks: recorder.callbacks,
  };
  await graph.updateState(config, {
    messages: oldMessages,
    taskActiveDelegation: oldDelegation,
    runId: oldDelegation.runId,
  });

  const state = await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage('这是全新的请求')]),
    config,
  ) as OrchestratorStateType;

  assert.equal(structuredCallCount, 3);
  const observedFreshDelegation = executedDelegation as {
    delegationId: string;
    runId: string;
  } | null;
  assert.ok(observedFreshDelegation);
  assert.notEqual(observedFreshDelegation.delegationId, oldDelegation.id);
  assert.notEqual(observedFreshDelegation.runId, oldDelegation.runId);
  assert.equal(
    recorder.subagentInputs.flat().some((message) =>
      message instanceof ToolMessage
      && message.content === 'OLD_DELEGATION_TOOL_RESULT'),
    false,
  );
  assert.equal(
    selectCapabilityHistory(
      state.messages,
      oldDelegation.lane,
      oldDelegation.runId,
      oldDelegation.id,
    ).some((message) => message instanceof ToolMessage),
    true,
  );
});

test('explicit resume reuses checkpointed delegation identity and ToolMessages', async () => {
  const activeDelegation: TaskActiveDelegation = {
    id: 'resume-pending-delegation',
    lane: 'capability:general',
    task: '继续原来的仓库检查',
    contextSummary: '已经完成第一步。',
    runId: 'resume-pending-run',
    traceId: 'resume-pending-trace',
    status: 'awaiting_decision',
    resultPreview: '第一步完成后，需要用户确认检查方向。',
    userRequest: '完成原来的仓库检查并报告结果。\n\n用户要求重点检查最新修改。',
  };
  const oldMessages: BaseMessage[] = interruptedLaneMessages({
    delegationId: activeDelegation.id,
    runId: activeDelegation.runId,
  });
  const priorAnnounce = createPrivateAnnounce({
    id: 'prior-resume-announce',
    lane: activeDelegation.lane,
    runId: activeDelegation.runId,
    completionReason: 'natural',
    delegationId: activeDelegation.id,
    task: activeDelegation.task,
    result: activeDelegation.resultPreview ?? '',
  });
  oldMessages.push(priorAnnounce);
  const plannerInputs: CapabilityPlannerInput[] = [];
  let executedDelegation: { delegationId: string; runId: string } | null = null;
  const actModel = {
    invoke: async () => new AIMessage('原任务继续完成。'),
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
    withStructuredOutput: () => ({ invoke: async () => goalDoneDecision() }),
  } as unknown as AgentModels['act'];
  const resumedCapability: AgentCapability = {
    ...capability('general', 'General-purpose capability.'),
    lifecycle: {
      finalize: (_result, context) => {
        executedDelegation = {
          delegationId: context.delegationId,
          runId: context.runId,
        };
      },
    },
  };
  const recorder = createSubagentInputRecorder();
  const graph = createOrchestratorGraph({
    models: {
      act: actModel,
      observe: actModel,
      subagent: new FakeListChatModel({
        responses: ['继续执行后的交付结果。'],
        sleep: 0,
      }),
    },
    actor: testActor,
    checkpoint: new MemorySaver(),
    capabilityPlannerRunner: {
      async invoke(input) {
        plannerInputs.push(input);
        return plannerInputs.length === 1
          ? {
            action: 'continue_current',
            tasks: [],
          }
          : { action: 'goal_done', tasks: [] };
      },
    },
  });
  const config = {
    configurable: {
      thread_id: 'explicit-resume-checkpointed-pending',
      actor: testActor,
      capabilities: [resumedCapability],
      toolkits: [],
    },
    callbacks: recorder.callbacks,
  };
  await graph.updateState(config, {
    messages: oldMessages,
    taskActiveDelegation: activeDelegation,
    runId: activeDelegation.runId,
  });

  const state = await graph.invoke(
    buildOrchestratorRunInput(
      [new HumanMessage('继续，并优先检查最新修改')],
      { activeDelegationTransition: 'resume_active' },
    ),
    config,
  ) as OrchestratorStateType;

  assert.equal(plannerInputs.length, 2);
  assert.deepEqual(executedDelegation, {
    delegationId: activeDelegation.id,
    runId: activeDelegation.runId,
  });
  assert.deepEqual(state.runUserRequest, activeDelegation.userRequest);
  assert.notEqual(state.runId, activeDelegation.runId);
  assert.equal(state.traceId, activeDelegation.traceId);
  assert.equal(plannerInputs[0]?.traceId, activeDelegation.traceId);
  assert.equal(plannerInputs[0]?.activeDelegation?.delegationId, activeDelegation.id);
  assert.match(plannerMessageContextText(plannerInputs[0]), /优先检查最新修改/);
  assert.match(plannerInputs[0]?.announceAttempts[0]?.result ?? '', /需要用户确认检查方向/);
  assert.equal(plannerInputs[0]?.latestAnnounce?.messageId, 'prior-resume-announce');
  assert.ok(plannerInputs[1]?.latestAnnounce?.messageId);
  assert.notEqual(plannerInputs[1]?.latestAnnounce?.messageId, 'prior-resume-announce');
  assert.equal(
    plannerInputs[1]?.inputId,
    `announce:${activeDelegation.id}:${plannerInputs[1]?.latestAnnounce?.messageId}`,
  );
  const resumedInput = recorder.subagentInputs.at(-1) ?? [];
  assert.equal(
    resumedInput.some((message) =>
      message instanceof ToolMessage
      && message.content === 'OLD_DELEGATION_TOOL_RESULT'),
    true,
  );
  const resumedBriefing = resumedInput.filter(isDelegationBriefingMessage).at(-1);
  assert.ok(resumedBriefing);
  assert.match(
    String(resumedBriefing.content),
    /<run_user_request role="goal_context"[\s\S]*完成原来的仓库检查并报告结果。[\s\S]*用户要求重点检查最新修改。[\s\S]*<\/run_user_request>/,
  );
  assert.equal(
    getAgentMessageRunId(resumedBriefing),
    null,
  );
  assert.equal(
    resumedInput
      .filter((message) => getAgentMessageLane(message) === activeDelegation.lane)
      .every((message) =>
        getAgentMessageRunId(message) === activeDelegation.runId),
    true,
  );
  assert.match(
    resumedInput.map((message) => String(message.content)).join('\n'),
    /继续，并优先检查最新修改/,
  );
});

test('legacy object UserRequest checkpoint returns a fixed incompatibility reply without models', async () => {
  const activeDelegation = {
    id: 'legacy-resume-delegation',
    lane: 'capability:general',
    task: '完成旧 checkpoint 中的仓库检查',
    contextSummary: '旧 checkpoint 没有 runUserRequest。',
    runId: 'legacy-resume-run',
    traceId: 'legacy-resume-trace',
    status: 'awaiting_decision',
    resultPreview: '仓库检查已经完成。',
    userRequest: {
      objective: '完成旧 checkpoint 中的仓库检查。',
      context: '旧版结构化目标。',
    },
  } as unknown as TaskActiveDelegation;
  const priorAnnounce = createPrivateAnnounce({
    lane: activeDelegation.lane,
    runId: activeDelegation.runId,
    completionReason: 'natural',
    delegationId: activeDelegation.id,
    task: activeDelegation.task,
    result: activeDelegation.resultPreview ?? '',
  });
  let modelInvocations = 0;
  const actModel = {
    invoke: async () => {
      modelInvocations += 1;
      throw new Error('incompatible checkpoint must not invoke a model');
    },
    bindTools: () => ({
      invoke: async () => {
        throw new Error('legacy checkpoint recovery must not invoke the Planner model');
      },
    }),
    withStructuredOutput: () => ({
      invoke: async () => taskDoneDecision('旧 checkpoint 中的任务已完成。'),
    }),
  } as unknown as AgentModels['act'];
  const graph = createRuntimeOrchestratorGraph({
    models: {
      act: actModel,
      observe: actModel,
      subagent: new FakeListChatModel({ responses: [], sleep: 0 }),
    },
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const config = {
    configurable: {
      thread_id: 'legacy-resume-without-user-goal',
      actor: testActor,
      capabilities: [capability('general', 'General-purpose capability.')],
      toolkits: [],
      registry: compileAgentRegistry({
        capabilities: [capability('general', 'General-purpose capability.')],
        toolkits: [],
      }),
    },
  };
  await graph.updateState(config, {
    messages: [priorAnnounce],
    taskActiveDelegation: activeDelegation,
    runId: activeDelegation.runId,
  });

  const state = await graph.invoke(
    buildOrchestratorRunInput(
      [new HumanMessage('继续完成剩余工作')],
      { activeDelegationTransition: 'resume_active' },
    ),
    config,
  ) as OrchestratorStateType;

  assert.equal(state.taskActiveDelegation, null);
  assert.equal(state.runLatestDelegationOutcome, null);
  assert.equal(state.runRuntimeFailure, null);
  assert.equal(state.runUserRequest, null);
  assert.equal(
    String(state.messages.at(-1)?.content ?? ''),
    '这个任务由旧版本创建，当前版本无法继续。请重新发起或重述任务。',
  );
  assert.equal(modelInvocations, 0);
});

test('delegation briefing stays invocation-scoped across sequential tasks', async () => {
  let structuredCallCount = 0;
  const actModel = {
    invoke: async () => new AIMessage('两项任务都已完成。'),
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
    withStructuredOutput: () => ({
      invoke: async () => {
        structuredCallCount += 1;
        if (structuredCallCount === 1) {
          return scriptedPlannerTask(
            '关闭 GitHub Issue #272。',
            [{ capability: 'ops', task: '删除 packages/goat 目录。' }],
          );
        }
        if (structuredCallCount === 2) return scriptedPlannerCapability('ops');
        if (structuredCallCount === 3) return taskDoneDecision('issue 已关闭，还需删除目录。');
        if (structuredCallCount === 4) {
          return scriptedPlannerTask('删除 packages/goat 目录。');
        }
        if (structuredCallCount === 5) return scriptedPlannerCapability('ops');
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeListChatModel({
    responses: ['Issue #272 已关闭。', 'packages/goat 目录已删除。'],
    sleep: 0,
  });
  const recorder = createSubagentInputRecorder();
  const graph = createOrchestratorGraph({
    models: { act: actModel, observe: actModel, subagent: subagentModel },
    actor: testActor,
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('关闭 issue #272，然后删除 packages/goat 目录。'),
  ]), {
    configurable: {
      thread_id: 'briefing-a-plus-b',
      actor: testActor,
      capabilities: [capability(
        'ops',
        '仓库运维：issue 操作、文件清理。',
        ['artifact_discovery'],
      )],
      allowedCapabilityNames: ['ops'],
      toolkits: [{
        name: 'artifact_discovery',
        description: 'artifact discovery toolkit',
        tools: toolDefinitions(
          mockTool('artifact_list'),
          mockTool('artifact_read'),
        ),
      }],
    },
    callbacks: recorder.callbacks,
  }) as OrchestratorStateType;

  // Completed delegation lanes are cleared without copying per-task plans into
  // the private lane. The main history retains one accepted announce per task.
  assert.equal(state.messages.filter(isDelegationBriefingMessage).length, 0);
  assert.equal(state.messages.filter((message) => getMessageHandoffSource(message)).length, 2);

  // Each selected subagent receives one complete invocation-scoped briefing.
  assert.equal(recorder.subagentInputs.length, 2);
  const [firstInput, secondInput] = recorder.subagentInputs;
  for (const input of recorder.subagentInputs) {
    const briefings = input.filter(isDelegationBriefingMessage);
    assert.equal(briefings.length, 1);
    const latestBriefing = briefings[0];
    assert.ok(latestBriefing);
    assert.equal(input.at(-1), latestBriefing);
    assert.match(String(latestBriefing.content), /<run_user_request role="goal_context"/);
    assert.equal(
      String(latestBriefing.content).includes(String(state.runUserRequest)),
      true,
    );
  }
  const briefingA = String(firstInput.find(isDelegationBriefingMessage)?.content ?? '');
  const briefingB = String(secondInput.filter(isDelegationBriefingMessage).at(-1)?.content ?? '');
  assert.match(briefingA, /^<delegation_briefing[^>]*mode="initial">/);
  assert.match(briefingA, /<task>[\s\S]*关闭 GitHub Issue #272。[\s\S]*<\/task>/);
  assert.match(briefingB, /<task>[\s\S]*删除 packages\/goat 目录。[\s\S]*<\/task>/);
  assert.doesNotMatch(briefingB, /<essential_context>/);
  assert.doesNotMatch(briefingB, /计划进度|剩余计划|\[已完成\]/);

  // The original user request is intact — no copy, rewrite, or demotion.
  const humanMessages = state.messages.filter((message) => message._getType() === 'human');
  assert.equal(humanMessages.length, 1);
  assert.equal(String(humanMessages[0].content), '关闭 issue #272，然后删除 packages/goat 目录。');

  // Subagent model input: the current Human briefing is appended after the
  // selected canonical main and delegation private messages.
  assert.match(String(firstInput.at(-1)?.content), /<delegation_briefing[\s\S]*关闭 GitHub Issue #272/);
  assert.match(String(secondInput.at(-1)?.content), /<delegation_briefing[\s\S]*删除 packages\/goat 目录/);
  const secondInputText = secondInput.map((message) => String(message.content)).join('\n');
  assert.match(secondInputText, /Issue #272 已关闭。/);
  assert.doesNotMatch(
    state.messages.map((message) => String(message.content)).join('\n'),
    /可选历史 artifacts/,
  );

  // Per-delegation task data stays in the briefing instead of being copied
  // into system context.
  for (const input of recorder.subagentInputs) {
    const systemMessages = input.filter((message) => message._getType() === 'system');
    assert.ok(systemMessages.length > 0);
    for (const message of systemMessages) {
      const systemText = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content);
      assert.doesNotMatch(systemText, /关闭 GitHub Issue #272/);
      assert.doesNotMatch(systemText, /上下文摘要/);
    }
  }
});

test('continue_current projects a continuation briefing without rewriting the task', async () => {
  let structuredCallCount = 0;
  const actModel = {
    invoke: async () => new AIMessage('issue 已确认关闭。'),
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
    withStructuredOutput: () => ({
      invoke: async () => {
        structuredCallCount += 1;
        if (structuredCallCount === 1) {
          return scriptedPlannerTask('关闭 GitHub Issue #272。');
        }
        if (structuredCallCount === 2) return scriptedPlannerCapability('ops');
        if (structuredCallCount === 3) return continueDecision('未验证 issue 状态，请确认已关闭。');
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeListChatModel({
    responses: ['已尝试关闭 issue。', 'issue 已确认关闭。'],
    sleep: 0,
  });
  const recorder = createSubagentInputRecorder();
  const graph = createOrchestratorGraph({
    models: { act: actModel, observe: actModel, subagent: subagentModel },
    actor: testActor,
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('关闭 issue #272。'),
  ]), {
    configurable: {
      thread_id: 'briefing-continue-gap',
      actor: testActor,
      capabilities: [capability('ops', '仓库运维：issue 操作。')],
      allowedCapabilityNames: ['ops'],
    },
    callbacks: recorder.callbacks,
  }) as OrchestratorStateType;

  assert.equal(state.messages.filter(isDelegationBriefingMessage).length, 0);
  assert.equal(recorder.subagentInputs.length, 2);
  for (const input of recorder.subagentInputs) {
    const briefings = input.filter(isDelegationBriefingMessage);
    assert.equal(briefings.length, 1);
    assert.match(String(briefings[0]?.content), /<run_user_request role="goal_context"/);
  }
  const continuation = String(
    recorder.subagentInputs[1].filter(isDelegationBriefingMessage).at(-1)?.content ?? '',
  );
  assert.match(continuation, /^<delegation_briefing[^>]*mode="continue">/);
  assert.match(
    continuation,
    /<task>[\s\S]*关闭 GitHub Issue #272。[\s\S]*<\/task>/,
  );
  assert.doesNotMatch(continuation, /<guidance>/);

  // The continuation run keeps the same delegation private messages and reads the
  // continuation briefing as the latest message.
  const secondInput = recorder.subagentInputs[1];
  assert.match(String(secondInput.at(-1)?.content), /^<delegation_briefing[^>]*mode="continue">/);
  const secondInputText = secondInput.map((message) => String(message.content)).join('\n');
  assert.match(secondInputText, /<delegation_announce version="1" role="data" authority="none">/);
  assert.match(secondInputText, /已尝试关闭 issue。/);
});
