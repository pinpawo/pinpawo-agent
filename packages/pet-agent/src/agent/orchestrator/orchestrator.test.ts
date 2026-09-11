import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages/tool';
import { tool, type StructuredTool, type ToolRuntime } from '@langchain/core/tools';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Command, MemorySaver, messagesStateReducer } from '@langchain/langgraph';
import { createMiddleware, FakeToolCallingModel } from 'langchain';
import { z } from 'zod';
import { ORCHESTRATOR_MAX_ITERATIONS } from './runtime/constants';
import { settleAbortedRun } from './interrupt';
import {
  defineInstructionDocument,
  type AgentCapability,
} from '../../types/capability';
import type { AgentModels } from '../../types/agent';
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
  reconcileDelegationMessages,
  setAgentMessageDelegationScope,
  setAgentMessageMetadata,
  toolProtocolSafeMessages,
} from '../messages';
import {
  DelegationAnnounceMessage,
  getDelegationAnnounce,
  isDelegationBriefingMessage,
  materializeDelegation,
} from './delegation';
import { RemoveMessage } from '@langchain/core/messages';
import {
  createContextCompactionMessage,
  isContextCompactionMessage,
} from './contextCompaction';

function isTypedDelegationAnnounce(message: BaseMessage) {
  return getDelegationAnnounce(message) !== null;
}

function createMainAnnounce(params: {
  id?: string;
  lane: `capability:${string}`;
  runId: string;
  delegationId: string;
  task?: string | null;
  result: string;
  completionReason?: 'natural' | 'limit_reached' | 'error';
}) {
  const announceMessageId = params.id ?? `announce:${params.runId}:${params.delegationId}`;
  return new DelegationAnnounceMessage({
    id: announceMessageId,
    sourceLane: params.lane,
    runId: params.runId,
    delegationId: params.delegationId,
    announceMessageId,
    task: params.task ?? null,
    result: params.result,
    createdAt: '2026-08-31T00:00:00.000Z',
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
import type { SubagentRuntimeContext } from '../../types/subagent';
import {
  ORCHESTRATOR_STATE_CHANNEL_NAMES,
  type OrchestratorStateType,
} from './state';
import {
  type RunSupervisorInput,
} from './runSupervisor/runner';
import { withScriptedDelegation, type ScriptedSupervisorDecision as RunSupervisorResult,
  type ScriptedSupervisorRunner as RunSupervisorRunner } from './runSupervisor/testing';
import { currentSupervisorTask } from './runSupervisor/state';
import { executionsForTask, readCapabilityExecutions, readDelegationDeliveries } from './executionMessages';
import type { DelegationDelivery } from './delegation/delivery';

function currentExecution(input: RunSupervisorInput | undefined) {
  if (!input) return null;
  const task = currentSupervisorTask(input.state);
  if (!task) return null;
  const latest = executionsForTask(input, task.id).at(-1);
  return latest ? { ...latest.execution, runId: String(latest.metadata.runId) } : null;
}
function executionDeliveries(input: RunSupervisorInput | undefined): DelegationDelivery[] {
  return (input?.messages ?? []).flatMap((message) => {
    if (!ToolMessage.isInstance(message) || message.name !== 'delegate_capability') return [];
    const result = JSON.parse(message.text);
    return result.delivery ? [result.delivery as DelegationDelivery] : [];
  });
}

import { readMessageText } from './utils';
import { PLAN_REQUEST_TOOL_NAME } from './runtime/nodes/entryAnswer';

function plannerMessageContextText(input: RunSupervisorInput | null | undefined) {
  return [...(input?.messages.map(readMessageText) ?? []), ...executionDeliveries(input ?? undefined).map((delivery) => delivery.text)].join('\n');
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
  config: Omit<Parameters<typeof createRuntimeOrchestratorGraph>[0], 'runSupervisorRunner'> & { runSupervisorRunner?: RunSupervisorRunner },
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
              id: `test-plan-request:${randomUUID()}`,
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
    runSupervisorRunner:
      withScriptedDelegation(config.runSupervisorRunner ?? createQueuedPlannerRunner(config.models.act)),
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
  const withCurrentPlannerCheckpoint = (input: unknown) => input;
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
): RunSupervisorRunner {
  const nextStructuredValue = async () => {
    const structured = model.withStructuredOutput(
      z.record(z.unknown()),
      { name: 'scripted_run_supervisor' },
    );
    return await structured.invoke([]) as Record<string, unknown>;
  };

  return {
    async invoke(input: RunSupervisorInput): Promise<RunSupervisorResult> {
      const planning = await nextStructuredValue();
      if (planning.action === 'unavailable') {
        return {
          reply: '当前没有可用的 Capability。',
        };
      }
      if (input.mode === 'boundary' && typeof planning.outcome === 'string') {
        if (planning.outcome === 'goal_done') {
          return {
            name: 'review_current', args: {
              completed: true,
              reason: 'Current task delivery is evidenced.',
              reply: '已完成。'
            }
          };
        }
        if (planning.outcome === 'user_input_required') {
          return {
            reply: typeof planning.question === 'string'
                ? planning.question
                : '请提供继续当前任务所需的选择或信息。',
          };
        }
        if (planning.outcome === 'continue') {
          const active = currentExecution(input);
          if (!active) throw new Error('scripted continue requires active delegation');
          return {
            name: 'review_current', args: {
              completed: false,
              reason: typeof planning.gap_note === 'string' && planning.gap_note.trim()
                ? planning.gap_note : 'Complete the missing current-task work.'
            }
          };
        }
        if (planning.outcome !== 'task_done') {
          throw new Error(`unsupported scripted supervisor outcome ${planning.outcome}`);
        }
        if (announces(input).length === 0) {
          return {
            reply: '当前没有可用的 Capability。',
          };
        }
        return this.invoke(input);
      }
      const [nextTask, ...remainingTasks] = Array.isArray(planning.tasks)
        ? planning.tasks as Array<{ capability?: unknown; task?: unknown }>
        : [];
      if (!nextTask) {
        throw new Error('scripted Run Supervisor requires at least one task');
      }
      const capabilityName = String(
        (await nextStructuredValue()).capabilityName ?? '',
      );
      if (input.mode === 'boundary') {
        return {
          name: 'review_current', args: {
            completed: true,
            reason: 'Current task delivery is evidenced.',
            ...(input.state.plan.filter((task) => task.status === 'pending').length === 1 ? { reply: '已完成。' } : {})
          }
        };
      }
      return {
        name: 'submit_plan', args: {
          tasks: [
            {
              capability: capabilityName,
              task: String(nextTask.task ?? ''),
            },
            ...remainingTasks.map((task) => ({
              capability: String(task.capability ?? ''),
              task: String(task.task ?? ''),
            })),
          ]
        }
      } as RunSupervisorResult;
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
  assert.equal(ORCHESTRATOR_STATE_CHANNEL_NAMES.includes('runSupervisorState'), true);
  assert.equal(ORCHESTRATOR_STATE_CHANNEL_NAMES.includes('runCapabilityPlan'), false);
  assert.equal(ORCHESTRATOR_STATE_CHANNEL_NAMES.includes('runCapabilityDisclosure'), true);
});

test('run identity is fresh while task trace identity can be supplied by the caller', () => {
  const first = buildOrchestratorRunInput([new HumanMessage('first')], {
    traceId: 'task-trace-1',
  });
  const resumed = buildOrchestratorRunInput([new HumanMessage('resume')], {
    traceId: first.traceId,
  });

  assert.equal(first.traceId, 'task-trace-1');
  assert.equal(resumed.traceId, first.traceId);
  assert.notEqual(resumed.runId, first.runId);
  assert.equal('runSupervisorState' in first, false, 'fresh run reset preserves saved plan');
  assert.equal('runSupervisorSession' in resumed, false);
});

function readToolMessages(messages: unknown[]) {
  return messages.filter((item): item is ToolMessage => item instanceof ToolMessage);
}

function scriptedPlannerTask(
  task: string,
  remainingPlan: Array<{ capability: string; task: string }> = [],
) {
  return {
    tasks: [{ capability: '', task }, ...remainingPlan],
  };
}

function scriptedSupervisorCapability(capabilityName: string) {
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

test('execution boundary routes through runSupervisor before the next task', async () => {
  const supervisorInputs: RunSupervisorInput[] = [];
  let answerMessages: BaseMessage[] = [];
  const routeModel = {
    invoke: async (messages: BaseMessage[]) => {
      answerMessages = messages;
      return new AIMessage('final summary');
    },
  } as unknown as AgentModels['act'];
  const runSupervisorRunner: RunSupervisorRunner = {
    async invoke(input) {
      supervisorInputs.push(input);
      if (supervisorInputs.length === 1) {
        return {
          capabilityDisclosure: { ...input.capabilityDisclosure, disclosedCapabilityNames: ['explore'] },
          name: 'submit_plan', args: {
            tasks: [{
              capability: 'explore',
              task: '读取 issue #269 并提炼需求点。',
            }, { capability: 'explore', task: '检索本地实现与 git log，判断需求点是否已覆盖。' }]
          }
        };
      }
      if (supervisorInputs.length === 3) {
        return {
          name: 'review_current', args: {
            completed: true,
            reason: 'Current task delivery is evidenced.',
            reply: '已完成。'
          }
        };
      }
      return {
        name: 'review_current', args: {
          completed: true,
          reason: 'Current task delivery is evidenced.'
        }
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
    runSupervisorRunner,
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
      capabilities: [capability('explore', '通用探索、调查、代码库理解 capability。')],
      allowedCapabilityNames: ['explore'],
    },
  }) as OrchestratorStateType;

  assert.equal(supervisorInputs.length, 3);
  const entryPlannerInput = supervisorInputs[0];
  const boundaryPlannerInput = supervisorInputs[1];
  assert.equal(entryPlannerInput?.mode, 'entry');
  assert.equal(boundaryPlannerInput?.mode, 'boundary');
  assert.deepEqual(boundaryPlannerInput?.capabilityDisclosure, {
    registryDigest: entryPlannerInput?.catalog.registryDigest,
    disclosedCapabilityNames: ['explore'],

  });
  assert.deepEqual(supervisorInputs[2]?.capabilityDisclosure, boundaryPlannerInput?.capabilityDisclosure);
  assert.equal(entryPlannerInput?.userRequest, '看 issue #269，再查本地实现，最后总结。');
  assert.deepEqual(boundaryPlannerInput?.userRequest, entryPlannerInput?.userRequest);
  assert.equal(currentExecution(supervisorInputs[1])?.task, '读取 issue #269 并提炼需求点。');
  assert.match(announces(supervisorInputs[1])[0]?.result ?? '', /issue #269 需求点/);
  assert.equal(announces(supervisorInputs[1]).length, 1);
  const secondBoundaryInput = supervisorInputs[2];
  const acceptedFirstTaskAnnounce = executionDeliveries(secondBoundaryInput).find((delivery) =>
    delivery.scope.delegationId
      === currentExecution(supervisorInputs[1])?.delegationId);
  assert.ok(acceptedFirstTaskAnnounce);
  assert.equal(announces(secondBoundaryInput).length, 1);
  assert.notEqual(
    announces(secondBoundaryInput)[0]?.messageId,
    acceptedFirstTaskAnnounce.id,
  );
  assert.ok(announces(supervisorInputs[1]).at(-1)?.messageId);
  assert.equal(
    supervisorInputs[1]?.inputId,
    `boundary:${supervisorInputs[1].runId}:1`,
  );
  assert.deepEqual(state.runSupervisorState.plan.map((item) => item.status), ['completed', 'completed']);
  assert.equal('runSupervisorSession' in state, false);
  assert.equal('runNextDelegation' in state, false);
  assert.equal(currentSupervisorTask(state.runSupervisorState), null);
  assert.equal('taskRunContinuation' in state, false);
  assert.equal(state.messages.some((message) =>
    readMessageText(message).includes('<supervision_boundary_event')), false);
  assert.equal(answerMessages.length, 0);
  const handoffs = state.messages.filter((message) => getDelegationAnnounce(message));
  assert.equal(handoffs.length, 0);
  assert.equal(readDelegationDeliveries(state.messages).length, 2);

});

test('a completed single-task goal is accepted by the boundary Supervisor', async () => {
  const supervisorInputs: RunSupervisorInput[] = [];
  const routeModel = {
    invoke: async () => new AIMessage('final summary'),
  } as unknown as AgentModels['act'];
  const runSupervisorRunner: RunSupervisorRunner = {
    async invoke(input) {
      supervisorInputs.push(input);
      return input.mode === 'entry'
        ? { name: 'submit_plan', args: { tasks: [{ capability: 'explore', task: '读取 issue #587 状态。' }] } }
        : {
          name: 'review_current', args: {
            completed: true,
            reason: 'Current task delivery is evidenced.',
            reply: '已完成。'
          }
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
    runSupervisorRunner,
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('看下 issue #587 现在什么状态。'),
  ]), {
    configurable: {
      thread_id: 'boundary-exhausted-plan',
      capabilities: [capability('explore', '通用探索、调查、代码库理解 capability。')],
      allowedCapabilityNames: ['explore'],
    },
  }) as OrchestratorStateType;

  assert.equal(supervisorInputs.length, 2);
  assert.equal(supervisorInputs[0]?.mode, 'entry');
  assert.equal(supervisorInputs[1]?.mode, 'boundary');
  assert.equal('runNextDelegation' in state, false);
  assert.equal('runSupervisorSession' in state, false);
});

test('Supervisor boundary returns to runSupervisor until the remaining goal is complete', async () => {
  let answerModelInvocations = 0;
  const supervisorInputs: RunSupervisorInput[] = [];
  const routeModel = {
    invoke: async () => {
      answerModelInvocations += 1;
      return new AIMessage('issue #269 的需求与本地实现检查均已完成，并确认了兼容性要求。');
    },
  } as unknown as AgentModels['act'];
  const runSupervisorRunner: RunSupervisorRunner = {
    async invoke(input) {
      supervisorInputs.push(input);
      if (input.mode === 'entry') {
        return {
          name: 'submit_plan', args: {
            tasks: [{
              capability: 'explore',
              task: '读取 issue #269 并提炼需求点。',
            }, {
              capability: 'explore',
              task: '检索本地实现与 git log。',
            }]
          }
        };
      }
      if (supervisorInputs.length === 3) {
        return {
          name: 'review_current', args: {
            completed: true,
            reason: 'Current task delivery is evidenced.',
            reply: '已完成。'
          }
        };
      }
      return {
        name: 'review_current', args: {
          completed: true,
          reason: 'Current task delivery is evidenced.'
        }
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
    runSupervisorRunner,
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('看 issue #269，再查本地实现。'),
  ]), {
    configurable: {
      thread_id: 'stage-b-task-done-no-plan',
      capabilities: [capability('explore', '通用探索、调查、代码库理解 capability。')],
      allowedCapabilityNames: ['explore'],
    },
  }) as OrchestratorStateType;

  assert.equal(supervisorInputs.length, 3);
  assert.deepEqual(supervisorInputs.map(({ mode }) => mode), ['entry', 'boundary', 'boundary']);
  assert.deepEqual(supervisorInputs[1]?.state.plan.filter((task) => task.status === 'pending').map(({ capability, task }) => ({ capability, task })), [{
    capability: 'explore',
    task: '读取 issue #269 并提炼需求点。',
  }, {
    capability: 'explore',
    task: '检索本地实现与 git log。',
  }]);
  assert.equal(currentExecution(supervisorInputs[1])?.task, '读取 issue #269 并提炼需求点。');
  assert.match(announces(supervisorInputs[1])[0]?.result ?? '', /issue #269 需求点：需要检查本地实现/);
  assert.doesNotMatch(plannerMessageContextText(supervisorInputs[1]), /announce truncated for Supervisor context/);
  assert.match(announces(supervisorInputs[1])[0]?.result ?? '', /完整 handoff 末尾约束：必须检查兼容性/);
  assert.equal(answerModelInvocations, 0);
  assert.equal(
    String(state.messages.at(-1)?.content ?? ''),
    '已完成。',
  );
  assert.deepEqual(state.runSupervisorState.plan.map((item) => item.status), ['completed', 'completed']);
  assert.equal('runSupervisorSession' in state, false);
  assert.equal('runNextDelegation' in state, false);
  assert.equal(currentSupervisorTask(state.runSupervisorState), null);
});

test('Supervisor return routes bounded facts through the answer node', async () => {
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
    runSupervisorRunner: {
      async invoke(input) {
        if (input.mode === 'boundary') {
          return {
            name: 'review_current', args: {
              completed: true,
              reason: 'Current task delivery is evidenced.',
              reply: '已完成。'
            }
          };
        }
        return {
          reply: '当前没有可用的 Capability。',
        };
      },
    },
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('帮我读取本地文件'),
  ]), {
    configurable: {
      thread_id: 'missing-executable-capability-routes-answer',
      capabilities: [],
      toolkits: [],
    },
  }) as OrchestratorStateType;

  assert.equal(mainConversationMessages(state.messages).at(-1)?.text, '当前没有可用的 Capability。');
  assert.doesNotMatch(answerInvocationText, /The compiled Capability registry is empty/);
  assert.equal(answerInvocationText, '');
  assert.equal('runNextDelegation' in state, false);
  assert.equal(currentSupervisorTask(state.runSupervisorState), null);
});

test('Entry Supervisor routes its structured user question through Answer without an active delegation', async () => {
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
    runSupervisorRunner: {
      async invoke() {
        return {
          reply: question,
        };
      },
    },
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('把服务部署到生产或预发布环境，目标由我决定。'),
  ]), {
    configurable: {
      thread_id: 'entry-supervisor-user-input-question',
      capabilities: [capability('general', 'Deploy after the user selects an environment.')],
      toolkits: [],
    },
  }) as OrchestratorStateType;

  assert.equal(answerInvocationText, '');
  assert.equal(state.messages.at(-1)?.text, question);
  assert.doesNotMatch(answerInputText, /<awaiting_user_input_context>/);
  assert.equal(currentSupervisorTask(state.runSupervisorState), null);
  assert.equal('runNextDelegation' in state, false);
  assert.equal('runSupervisorReply' in state, false);
});

test('Supervisor non-commit routes to Answer without inventing a General delegation', async () => {
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
    runSupervisorRunner: {
      async invoke() {
        plannerCalls += 1;
        return {
          reply: '需要补充信息。',
        };
      },
    },
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('修改当前仓库的 Supervisor 行为'),
  ]), {
    configurable: {
      thread_id: 'supervisor-non-commit-routes-answer',
      capabilities: [capability('general', 'General-purpose capability.')],
      toolkits: [],
    },
  }) as OrchestratorStateType;

  assert.equal(plannerCalls, 1);
  assert.equal(mainConversationMessages(state.messages).at(-1)?.text, '需要补充信息。');
  assert.equal(answerInvocationText, '');
  assert.equal('runNextDelegation' in state, false);
  assert.equal(currentSupervisorTask(state.runSupervisorState), null);
  assert.equal(state.runSupervisorState.plan.length, 0);
});




test('capability supervisor reports an empty compiled registry without inventing General', async () => {
  let supervisorMode: RunSupervisorInput['mode'] | null = null;
  let supervisorCapabilityNames: readonly string[] = [];
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
    runSupervisorRunner: {
      async invoke(input) {
        supervisorMode = input.mode;
        supervisorCapabilityNames = input.catalog.capabilityNames;
        return {
          reply: '当前没有可用的 Capability。',
        };
      },
    },
  });

  await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('完成一个需要执行能力的任务'),
  ]), {
    configurable: {
      thread_id: 'empty-capability-registry-supervisor-facts',
      capabilities: [],
      toolkits: [],
    },
  });

  assert.equal(supervisorMode, 'entry');
  assert.deepEqual(supervisorCapabilityNames, []);
});

test('Run Supervisor return is materialized without a second semantic policy check', async () => {
  const model = {
    invoke: async () => new AIMessage('done'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: { act: model },
    runSupervisorRunner: {
      async invoke() {
        return {
          reply: '当前没有可用的 Capability。',
        };
      },
    },
  });

  const result = await graph.invoke(buildOrchestratorRunInput([
      new HumanMessage('完成普通工作区任务'),
  ]), {
    configurable: {
      thread_id: 'general-fallback-model-policy',
      capabilities: [capability('general', '处理普通任务。')],
      toolkits: [],
    },
  });

  assert.equal(result.messages.at(-1)?.content, '当前没有可用的 Capability。');
});

test('allowedCapabilityNames scopes the immutable Supervisor catalog', async () => {
  let supervisorCapabilityNames: readonly string[] = [];
  const model = {
    invoke: async () => new AIMessage('answered'),
  } as unknown as AgentModels['act'];
  const runSupervisorRunner: RunSupervisorRunner = {
    async invoke(input) {
      supervisorCapabilityNames = input.catalog.capabilityNames;
      return {
        reply: '当前没有可用的 Capability。',
      };
    },
  };

  const graph = createOrchestratorGraph({
    models: {
      act: model,
      observe: model,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    runSupervisorRunner,
  });
  const input = buildOrchestratorRunInput([new HumanMessage('做一支讲秋日食材的短视频')]);

  await graph.invoke(input, {
    configurable: {
      thread_id: 'forced-cap-thread',
      capabilities: [
        capability('studio_plan', 'Supervisor 唯一的目标:把用户请求拆解为一份 plan。'),
        capability('other_cap', '某个无关 capability。'),
      ],
      tools: [],
      allowedCapabilityNames: ['studio_plan'],
    },
  });

  assert.deepEqual(supervisorCapabilityNames, ['studio_plan']);
});

test('Run Supervisor materializer rejects selections outside the catalog', async () => {
  const model = {
    invoke: async () => new AIMessage('answered'),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: model,
      observe: model,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    runSupervisorRunner: {
      async invoke(input) {
        assert.equal(input.mode, 'entry');
        return {
          name: 'submit_plan', args: {
            tasks: [{
              capability: 'not_registered',
              task: '读取 src/index.ts。',
            }]
          }
        };
      },
    },
  });

  await assert.rejects(
    graph.invoke(
      buildOrchestratorRunInput([new HumanMessage('帮我读取 src/index.ts')]),
      {
        configurable: {
          thread_id: 'supervisor-selection-outside-workspace',
          capabilities: [capability('general', '普通代码任务。')],
          tools: [],
        },
      },
    ),
    /outside the current catalog/,
  );
});

test('Run Supervisor owns the executable task boundary at entry', async () => {
  const model = {
    invoke: async () => new AIMessage('answered'),
  } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: {
      act: model,
      observe: model,
      subagent: new FakeToolCallingModel({ toolCalls: [[]] }),
    },
    runSupervisorRunner: {
      async invoke(input) {
        if (input.mode === 'boundary') {
          return {
            name: 'review_current', args: {
              completed: true,
              reason: 'Current task delivery is evidenced.',
              reply: '已完成。'
            }
          };
        }
        return {
          name: 'submit_plan', args: {
            tasks: [{
              capability: 'general',
              task: '检查 src/index.ts 并整理其公开接口。',
            }]
          }
        };
      },
    },
  });

  const state = await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage('帮我看看 src/index.ts')]),
    {
      configurable: {
        thread_id: 'supervisor-owns-entry-task-boundary',
        capabilities: [capability('general', '普通代码任务。')],
        tools: [],
      },
    },
  ) as OrchestratorStateType;

  assert.equal(
    state.runSupervisorState.plan[0]?.task,
    '检查 src/index.ts 并整理其公开接口。',
  );
});





test('supervisor errors checkpoint run-scoped cleanup before they are rethrown', async () => {
  const graph = createOrchestratorGraph({
    models: {
      act: new FakeListChatModel({ responses: ['unused'], sleep: 0 }),
    },
    checkpoint: new MemorySaver(),
    runSupervisorRunner: {
      invoke: async () => {
        throw new Error('supervisor failed');
      },
    },
  });
  const config = {
    configurable: {
      thread_id: 'supervisor-error-cleanup',
      capabilities: [capability('general', 'General-purpose capability.')],
      toolkits: [],
    },
  };

  await assert.rejects(
    graph.invoke(buildOrchestratorRunInput([
      new HumanMessage('执行会触发 Supervisor 失败的任务'),
    ]), config),
    /supervisor failed/,
  );

  const checkpoint = await graph.getState(config);
  const state = checkpoint.values as OrchestratorStateType;
  assert.equal('runSupervisorSession' in state, false);
  assert.equal('taskRunContinuation' in state, false);
  assert.equal(state.runTerminalError?.node, 'runSupervisor');
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
    messages: [],
  });
  const allExecution = await resolveToolkitExecution(toolkits, undefined, {
    models: {} as AgentModels,
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
          return scriptedSupervisorCapability('inspect_repo');
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
    toolkitRuntimeManager,
  });

  await graph.invoke(buildOrchestratorRunInput([new HumanMessage('inspect')]), {
    configurable: {
      thread_id: 'available-toolkits-runtime',
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
        if (routeCallCount === 2) return scriptedSupervisorCapability('inspect_browser');
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
    toolkitRuntimeManager,
  });

  await graph.invoke(buildOrchestratorRunInput([new HumanMessage('inspect')]), { context: { workdir: '/workspace', systemPromptSections: [] },
    configurable: {
      thread_id: 'browser-runtime-context',
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
        if (decisionCallCount === 2) return scriptedSupervisorCapability('browser_like');
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
  });

  await graph.invoke(buildOrchestratorRunInput([new HumanMessage('inspect')]), {
    configurable: {
      thread_id: 'capability-artifact-discovery-tools',
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
          return scriptedSupervisorCapability('general');
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
  });

  await graph.invoke(buildOrchestratorRunInput([new HumanMessage('inspect')]), {
    configurable: {
      thread_id: 'general-artifact-discovery-tools',
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
          return scriptedSupervisorCapability('general');
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
  });

  await graph.invoke(buildOrchestratorRunInput([new HumanMessage('inspect')]), {
    configurable: {
      thread_id: 'general-toolkit-registration',
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
          return scriptedSupervisorCapability('explore');
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
  });

  const state = await graph.invoke(buildOrchestratorRunInput([new HumanMessage('explore issue')]), {
    configurable: {
      thread_id: 'artifact-thread',
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
          return scriptedSupervisorCapability('content_writer');
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
  });

  const state = await graph.invoke(buildOrchestratorRunInput([new HumanMessage('post')]), {
    configurable: {
      thread_id: 'result-artifact-thread',
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
  assert.equal(Object.hasOwn(result ?? {}, 'completionReason'), false);
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
        if (step === 1) return scriptedSupervisorCapability('general');
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
    checkpoint,
  };
  const invokeConfig = {
    configurable: {
      thread_id: 'auto-authorization-across-graph-rebuild',
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
          return scriptedSupervisorCapability('general');
        }
        return { outcome: 'user_input_required', question: 'Execution returned no deliverable; please check the tool output.' };
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
    checkpoint: new MemorySaver(),
  });
  const config = {
    configurable: {
      thread_id: 'canonical-review-runtime-auth',
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
  const output = await resumedRun.output;
  assert.equal(readCapabilityExecutions(output.messages).at(-1)?.result?.status, 'missing_deliverable');
  const finalState = (await graph.getState(config)).values as {
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
          return scriptedSupervisorCapability('general');
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
    checkpoint: new MemorySaver(),
  });
  const config = {
    configurable: {
      thread_id: 'plain-review-runtime-state',
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
  const delivery = readDelegationDeliveries(finalState.messages).find((value) => value.task === 'run shell');
  assert.ok(delivery);
  assert.equal(delivery.scope.lane, 'capability:general');
  assert.ok(delivery.scope.delegationId);
  assert.match(delivery.text, /ran git status/);
  assert.equal(finalState.messages.some(getDelegationAnnounce), false);
});

test('toolkit review rejection records terminal tool results and retains the delegation', async () => {
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
          return scriptedSupervisorCapability('general');
        }
        return continueDecision();
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
    checkpoint: new MemorySaver(),
  });
  const recorder = createSubagentInputRecorder();
  const config = {
    callbacks: recorder.callbacks,
    configurable: {
      thread_id: 'human-reject-resumes-subagent-loop',
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

  assert.ok(interruptId);
  const invalidResume = await graph.invoke(new Command({
    resume: {
      [interruptId]: { decisions: [] },
    },
  }), config) as {
    __interrupt__?: Array<{
      id?: string;
      value?: { error?: string };
    }>;
  };
  const retryInterruptId = invalidResume.__interrupt__?.[0]?.id;
  assert.ok(retryInterruptId);
  assert.equal(invalidResume.__interrupt__?.[0]?.value?.error, 'invalid_decision');
  assert.equal(autoReviewCount, 1, 'invalid Review resume must not repeat auto-review');

  const reviewResume = {
    decisions: [{
      reviewId: 'tool-review:run_shell:call-rejected-first',
      selectedOptionId: 'reject',
    }],
  };
  const resumedRun = await graph.streamEvents(new Command({
    resume: { [retryInterruptId]: reviewResume },
  }), { version: 'v3', ...config });
  for await (const _event of resumedRun) {
    // Drain the root stream so the final output is materialized.
  }
  // The run now suspends on a pause interrupt instead of ending, so the
  // stream output carries the interrupt, not the channel values. Read state
  // from the checkpoint, as the Host does.
  const resumedOutput = await resumedRun.output as { __interrupt__?: unknown };
  const finalState = {
    ...(await graph.getState(config)).values,
    __interrupt__: resumedOutput.__interrupt__,
  } as {
    __interrupt__?: Array<{ id?: string; value?: { kind?: string } }>;
    messages: BaseMessage[];
    runSupervisorState: OrchestratorStateType['runSupervisorState'];
    runId: string;
  };

  assert.equal(finalState.__interrupt__?.[0]?.value?.kind, 'pause_task', 'a task pause suspends the run as a real interrupt');
  assert.equal(runCount, 0);
  assert.equal(reviewCount, 6);
  assert.equal(autoReviewCount, 1, 'pending review resume must reuse its checkpointed auto-review');
  assert.equal(routeCallCount, 2);
  assert.equal(recorder.subagentInputs.length, 1);
  const handoffCopy = mainConversationMessages(finalState.messages)
    .find((message) => Boolean(getDelegationAnnounce(message)));
  assert.equal(handoffCopy, undefined);
  assert.equal(currentSupervisorTask(finalState.runSupervisorState)?.status, 'pending');
  assert.equal(readCapabilityExecutions(finalState.messages).at(-1)?.result?.status, 'paused');

  const task = currentSupervisorTask(finalState.runSupervisorState);
  assert.ok(task);
  const previous = executionsForTask(finalState, task.id).at(-1);
  assert.ok(previous);
  const activeDelegation = { id: previous.execution.delegationId, lane: `capability:${task.capability}` as const, runId: String(previous.metadata.runId) };
  assert.ok(activeDelegation);
  const retainedLane = selectCapabilityHistory(
    finalState.messages,
    activeDelegation.lane,
    activeDelegation.runId,
    activeDelegation.id,
  );
  assert.equal(
    retainedLane.some((message) => ToolMessage.isInstance(message)),
    true,
  );
  const rejectedToolResults = retainedLane
    .filter((message): message is ToolMessage => ToolMessage.isInstance(message) && getAgentMessageLane(message) !== null)
    .map((message) => JSON.parse(String(message.content)) as {
      source?: string;
      skipped?: boolean;
    });
  assert.equal(rejectedToolResults.length, 2);
  assert.equal(rejectedToolResults[0]?.source, 'human_reject');
  assert.equal(rejectedToolResults[1]?.skipped, true);
  assert.equal(
    retainedLane.some((message) =>
      AIMessage.isInstance(message)
      && (message.tool_calls ?? []).some((toolCall) =>
        toolCall.id === 'call-rejected-first' || toolCall.id === 'call-rejected-second')),
    true,
  );

  const pauseInterruptId = finalState.__interrupt__?.[0]?.id;
  assert.ok(pauseInterruptId, 'pause interrupt must carry an id to continue by');
  const nextReview = await graph.invoke(
    new Command({
      resume: {
        [pauseInterruptId]: {
          action: 'continue',
          guidance: 'continue without the rejected action',
        },
      },
    }),
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
    continuedSubagentInput.some((message) => ToolMessage.isInstance(message) && getAgentMessageLane(message) !== null),
    true,
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
          return scriptedSupervisorCapability('general');
        }
        if (routeCallCount === 3) return continueDecision();
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
  // The run now suspends on a pause interrupt instead of ending, so the
  // stream output carries the interrupt, not the channel values. Read state
  // from the checkpoint, as the Host does.
  const resumedOutput = await resumedRun.output as { __interrupt__?: unknown };
  const finalState = {
    ...(await graph.getState(config)).values,
    __interrupt__: resumedOutput.__interrupt__,
  } as {
    __interrupt__?: Array<{ id?: string; value?: { kind?: string } }>;
    messages: BaseMessage[];
    runSupervisorState: OrchestratorStateType['runSupervisorState'];
    runId: string;
  };

  assert.equal(finalState.__interrupt__?.[0]?.value?.kind, 'pause_task', 'a task pause suspends the run as a real interrupt');
  assert.equal(runCount, 0);
  assert.equal(reviewCount, 2);
  assert.equal(routeCallCount, 2);
  assert.equal(recorder.subagentInputs.length, 1);
  assert.equal(finalizeCallCount, 0);
  assert.equal(currentSupervisorTask(finalState.runSupervisorState)?.status, 'pending');
  assert.equal('runNextDelegation' in finalState, false);
  assert.equal('runSupervisorSession' in finalState, false);
  assert.equal(
    mainConversationMessages(finalState.messages)
      .some((message) => Boolean(getDelegationAnnounce(message))),
    false,
  );

  const task = currentSupervisorTask(finalState.runSupervisorState);
  assert.ok(task);
  const previous = executionsForTask(finalState, task.id).at(-1);
  assert.ok(previous);
  const activeDelegation = { id: previous.execution.delegationId, lane: `capability:${task.capability}` as const, runId: String(previous.metadata.runId) };
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
    new Command({ resume: { [finalState.__interrupt__![0].id!]: { action: 'continue' } } }),
    config,
  ) as {
    messages: BaseMessage[];
    runSupervisorState: OrchestratorStateType['runSupervisorState'];
    runId: string;
  };

  assert.equal(routeCallCount, 4);
  assert.equal(recorder.subagentInputs.length, 2);
  assert.equal(finalizeCallCount, 1);
  const continuedSubagentInput = recorder.subagentInputs.at(-1) ?? [];
  assert.equal(
    continuedSubagentInput.some((message) => ToolMessage.isInstance(message)
      && getAgentMessageMetadata(message).lane === 'capability:general'),
    false,
  );
  const resumedHandoff = readDelegationDeliveries(continuedState.messages).find((delivery) =>
    delivery.scope.delegationId === retainedDelegationId);
  assert.ok(resumedHandoff);
  assert.equal(currentSupervisorTask(continuedState.runSupervisorState), null);
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
          return scriptedSupervisorCapability('general');
        }
        return { outcome: 'user_input_required', question: 'Execution returned no deliverable; please check the tool output.' };
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
    checkpoint: new MemorySaver(),
  });
  const config = {
    configurable: {
      thread_id: 'multi-tool-review-runtime-state',
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
  const output = await resumedRun.output;
  assert.equal(readCapabilityExecutions(output.messages).at(-1)?.result?.status, 'missing_deliverable');
  const finalState = (await graph.getState(config)).values as {
    __interrupt__?: unknown;
    messages: Array<AIMessage | HumanMessage | ToolMessage>;
  };

  assert.equal(finalState.__interrupt__, undefined);
  assert.equal(runCount, 2);
  assert.equal(reviewCount, 4);
});

test('old handoff metadata is not treated as an accepted delegation result', () => {
  const oldCopy = new AIMessage('旧 handoff 文本');
  setAgentMessageMetadata(oldCopy, {
    taskAccepted: true,
    handoffFrom: 'capability:general',
    delegationId: 'old-delegation',
    runId: 'old-run',
    task: '旧任务',
    announceMessageId: 'old-announce',
  });

  assert.equal(getDelegationAnnounce(oldCopy), null);
  assert.equal(getDelegationAnnounce(oldCopy), null);
});

test('execution without a deliverable returns an error result to Supervisor without accepting the task', async () => {
  const checkpoint = new MemorySaver();
  let boundaries = 0;
  const graph = createOrchestratorGraph({
    models: { act: new FakeListChatModel({ responses: ['unused'], sleep: 0 }),
      subagent: new FakeListChatModel({ responses: [''], sleep: 0 }) },
    checkpoint,
    runSupervisorRunner: { invoke: async (input) => {
      if (input.mode === 'boundary') {
        boundaries += 1;
        assert.equal(readCapabilityExecutions(input.messages).at(-1)?.result?.status, 'missing_deliverable');
        return { reply: 'No new deliverable was produced.' };
      }
      return { name: 'submit_plan', args: { tasks: [{ capability: 'general', task: 'Inspect files.' }] } };
    } },
  });
  const config = { configurable: { thread_id: 'no-deliverable', capabilities: [capability('general', 'Inspect files.')] } };
  await graph.invoke(buildOrchestratorRunInput([new HumanMessage('Inspect files.')]), config);
  const saved = (await graph.getState(config)).values as OrchestratorStateType;
  assert.equal(boundaries, 1);
  assert.equal(currentSupervisorTask(saved.runSupervisorState)?.status, 'pending');
  assert.equal('taskRunContinuation' in saved, false);
  assert.equal('runSupervisorSession' in saved, false);
  assert.equal(saved.messages.some((message) => getDelegationAnnounce(message)), false);
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

  const update = reconcileDelegationMessages({
    resultMessages: [human, finalAnswer],
    inputMessages: [human, persistedProgress, briefing],
    scope: { lane: 'capability:general', runId: 'turn-1', delegationId: 'task-1' },
    canonicalInputMessages: [human, persistedProgress],
  });
  const removedIds = update.removed
    .filter((message) => message instanceof RemoveMessage)
    .map((message) => message.id);

  assert.deepEqual(removedIds, ['old-progress']);
  assert.equal(removedIds.includes(briefing.id ?? ''), false);
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
      result: '<delegation_briefing mode="initial">\n  <task>已验收结果</task>\n</delegation_briefing>',
      createdAt: '2026-08-23T00:00:00.000Z',
    }),
  ];

  assert.deepEqual(mainConversationMessages(handoffs), handoffs);
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

  reconcileDelegationMessages({
    resultMessages: messages,
    inputMessages: [human],
    scope: { lane: 'capability:general', runId: 'turn-1', delegationId: 'task-1' },
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



test('fresh delegated request supersedes checkpointed work without deleting its lane', async () => {
  const oldDelegation = {
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
          return scriptedSupervisorCapability('general');
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
    checkpoint: new MemorySaver(),
  });
  const config = {
    configurable: {
      thread_id: 'fresh-turn-supersedes-checkpointed-awaiting',
      capabilities: [freshCapability],
      toolkits: [],
    },
    callbacks: recorder.callbacks,
  };
  await graph.updateState(config, {
    messages: oldMessages,
    runSupervisorState: { goal: oldDelegation.userRequest, plan: [{
      id: 'old-task', capability: 'general', task: oldDelegation.task, status: 'pending',
    }] },
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
      'capability:general',
      oldDelegation.runId,
      oldDelegation.id,
    ).some((message) => message instanceof ToolMessage),
    true,
  );
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
        if (structuredCallCount === 2) return scriptedSupervisorCapability('ops');
        if (structuredCallCount === 3) return taskDoneDecision('issue 已关闭，还需删除目录。');
        if (structuredCallCount === 4) {
          return scriptedPlannerTask('删除 packages/goat 目录。');
        }
        if (structuredCallCount === 5) return scriptedSupervisorCapability('ops');
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
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('关闭 issue #272，然后删除 packages/goat 目录。'),
  ]), {
    configurable: {
      thread_id: 'briefing-a-plus-b',
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
  // the private lane. Root keeps evidence outside the user-facing conversation.
  assert.equal(state.messages.filter(isDelegationBriefingMessage).length, 0);
  assert.equal(state.messages.filter((message) => getDelegationAnnounce(message)).length, 0);
  assert.equal(readDelegationDeliveries(state.messages).length, 2);

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

test('review_current projects a continuation briefing without rewriting the task', async () => {
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
        if (structuredCallCount === 2) return scriptedSupervisorCapability('ops');
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
  });

  const state = await graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('关闭 issue #272。'),
  ]), {
    configurable: {
      thread_id: 'briefing-continue-gap',
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
  assert.match(continuation, /未验证 issue 状态，请确认已关闭。/);

  // The continuation run keeps the same delegation private messages and reads the
  // continuation briefing as the latest message.
  const secondInput = recorder.subagentInputs[1];
  assert.match(String(secondInput.at(-1)?.content), /^<delegation_briefing[^>]*mode="continue">/);
  const secondInputText = secondInput.map((message) => String(message.content)).join('\n');
  assert.equal(secondInput.some(getDelegationAnnounce), false);
  assert.match(secondInputText, /已尝试关闭 issue。/);
});

test('Capability node inherits root system context into its executor without section forwarding', async () => {
  const common = [{ id: 'host:pet', content: randomUUID() }, { id: 'host:extra', content: randomUUID() }];
  const workdir = `/workspace/${randomUUID()}`;
  const { subagentInputs, callbacks } = createSubagentInputRecorder();
  const answer = { invoke: async () => new AIMessage('finished') } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: { act: answer, subagent: new FakeListChatModel({ responses: ['execution complete'], sleep: 0 }) },
    runSupervisorRunner: {
      async invoke(input) {
        return input.mode === 'entry'
          ? { name: 'submit_plan', args: { tasks: [{ capability: 'explore', task: 'Inspect the request.' }] } }
          : {
            name: 'review_current', args: {
              completed: true,
              reason: 'Current task delivery is evidenced.',
              reply: 'Done.'
            }
          };
      },
    },
  });
  const result = await graph.invoke(buildOrchestratorRunInput([new HumanMessage('Inspect this request.')]), {
    context: { workdir: workdir, systemPromptSections: common }, callbacks,
    configurable: { capabilities: [capability('explore', 'Inspect requests.')], toolkits: [] },
  });
  assert.equal(subagentInputs.length, 1);
  const systems = subagentInputs[0].filter(SystemMessage.isInstance);
  assert.equal(systems.length, 1);
  assert.equal(systems[0].text.split(workdir).length - 1, 1);
  assert.equal(systems[0].text.includes(workdir), true);
  for (const section of common) {
    assert.equal(systems[0].text.split(section.content).length - 1, 1);
    assert.equal(JSON.stringify(result.messages).includes(section.content), false);
  }
});

test('one compiled graph preserves execution scopes without actor metadata', async () => {
  const modelsSeen: string[] = [];
  const scopes: Array<{ threadId: string | null; workdir?: string | null }> = [];
  const toolsSeen = new Map<string, string | null | undefined>();
  const reviews = new Set<string>();
  const finalized = new Set<string>();
  class Executor extends BaseChatModel {
    _llmType() { return 'execution-context-test'; }
    bindTools() { return this; }
    async _generate(messages: BaseMessage[]) {
      modelsSeen.push(messages.filter(SystemMessage.isInstance).map(m => m.text).join('\n'));
      const message = messages.some((message) => ToolMessage.isInstance(message) && message.name === 'inspect_context')
        ? new AIMessage('inspected')
        : new AIMessage({ content: '', tool_calls: [{ id: randomUUID(), name: 'inspect_context', args: {} }] });
      return { generations: [{ message, text: message.text }] };
    }
  }
  const inspect = tool(async (_args, runtime: ToolRuntime<unknown, SubagentRuntimeContext>) => {
    const scope = runtime.context.executionScope!;
    assert.equal(scope.workdir, runtime.context.workdir);
    toolsSeen.set(scope.threadId!, runtime.context.workdir);
    return 'inspected';
  }, { name: 'inspect_context', description: 'Inspect invocation context.', schema: z.object({}) });
  const toolkit: AgentToolkit = {
    name: 'inspection', description: 'Inspect context',
    tools: [reviewedTool(inspect, ReviewPolicies.localMutation())],
    runtime: {
      start: () => ({}),
      resolve: (_root, context) => { scopes.push(context.execution); return {}; },
      bindTools: () => [inspect],
    },
  };
  const item = {
    ...capability('inspect', 'Inspect context', ['inspection']),
    lifecycle: { finalize: (_result: unknown, ctx: { threadId?: string | null }) => {
      assert.equal('actor' in ctx, false);
      finalized.add(ctx.threadId!);
    } },
  };
  const toolkitRuntimeManager = new ToolkitRuntimeManager();
  const answer = { invoke: async () => new AIMessage('done') } as unknown as AgentModels['act'];
  const graph = createOrchestratorGraph({
    models: { act: answer, subagent: new Executor({}) }, toolkitRuntimeManager,
    runSupervisorRunner: { async invoke(input) {
      return input.mode === 'entry'
        ? { name: 'submit_plan', args: { tasks: [{ capability: 'inspect', task: 'Inspect context.' }] } }
        : {
          name: 'review_current', args: {
            completed: true,
            reason: 'Current task delivery is evidenced.',
            reply: 'Done.'
          }
        };
    } },
  });
  const cases = Array.from({ length: 3 }, () => ({
    threadId: randomUUID(), workdir: `/workspace/${randomUUID()}`,
  }));
  const invoke = async ({ threadId, workdir }: typeof cases[number]) => {
    await graph.invoke(buildOrchestratorRunInput([new HumanMessage('inspect')]), {
      context: { workdir, systemPromptSections: [] },
      configurable: { thread_id: threadId, capabilities: [item], toolkits: [toolkit],
        globalReviewPolicy: { mode: 'custom', resolve: async (ctx: { workdir?: string | null }) => {
          assert.equal('actor' in ctx, false);
          reviews.add(ctx.workdir!);
          return { type: 'authorize' };
        } },
      },
    });
  };
  try {
    await Promise.all(cases.slice(0, 2).map(invoke));
    await invoke(cases[2]);
    assert.equal(finalized.size, 3);
    assert.equal(reviews.size, 3);
    for (const entry of cases) {
      assert.ok(finalized.has(entry.threadId));
      assert.ok(reviews.has(entry.workdir));
      assert.equal(toolsSeen.get(entry.threadId), entry.workdir);
      assert.equal(scopes.find(scope => scope.threadId === entry.threadId)?.workdir, entry.workdir);
      const inputs = modelsSeen.filter(text => text.includes(entry.workdir));
      assert.equal(inputs.length, 2);
      for (const text of inputs) {
        assert.equal(text.split(entry.workdir).length - 1, 1);
        for (const other of cases.filter(value => value !== entry)) assert.equal(text.includes(other.workdir), false);
      }
    }
  } finally {
    await toolkitRuntimeManager.stop();
  }
});

function announces(input: RunSupervisorInput | undefined) {
  const active = currentExecution(input);
  return [...(input?.messages ?? []).flatMap((message) => {
    const value = getDelegationAnnounce(message);
    return value && active && value.delegationId === active.delegationId && value.runId === active.runId
      ? [{ messageId: value.announceMessageId, result: value.result }] : [];
  }), ...(executionDeliveries(input)).filter((delivery) => active
    && delivery.scope.delegationId === active.delegationId && delivery.scope.runId === active.runId)
    .map((delivery) => ({ messageId: delivery.id, result: delivery.text }))];
}
test('a review-origin task pause consults Supervisor on guided continue by id', async () => {
  let runCount = 0;
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
      request: () => buildReviewSpec({
        view: { kind: 'plain', body: 'Approve shell?' },
        options: [
          { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
          { id: 'reject', label: 'Reject', decision: { type: 'reject', message: 'no' } },
        ],
      }),
    })],
  }];
  let routeCallCount = 0;
  const routeModel = {
    invoke: async () => new AIMessage('answered'),
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
    withStructuredOutput: () => ({
      invoke: async () => {
        routeCallCount += 1;
        if (routeCallCount === 1) return scriptedPlannerTask('run shell');
        if (routeCallCount === 2) return scriptedSupervisorCapability('general');
        if (routeCallCount === 3) return continueDecision('Inspect recent commits as requested.');
        return goalDoneDecision();
      },
    }),
  } as unknown as AgentModels['act'];
  const subagentModel = new FakeToolCallingModel({
    toolCalls: [
      [{ id: 'call-first', name: 'run_shell', args: { command: 'git status' } }],
      [{ id: 'call-after-continue', name: 'run_shell', args: { command: 'git log -1' } }],
      [],
    ],
  });
  const graph = createOrchestratorGraph({
    models: { act: routeModel, observe: routeModel, subagent: subagentModel },
    checkpoint: new MemorySaver(),
  });
  const recorder = createSubagentInputRecorder();
  const config = {
    callbacks: recorder.callbacks,
    configurable: {
      thread_id: 'experiment-pause-as-interrupt',
      capabilities: [capability('general', 'General-purpose capability.', ['local'])],
      toolkits,
      reviewCapabilities: { humanReview: true, sessionAuthorization: false },
      globalReviewPolicy: { mode: 'custom', resolve: () => ({ type: 'require_authorization' as const }) },
    },
  };
  type Out = { __interrupt__?: Array<{ id?: string; value?: { kind?: string } }> };

  // 1. run until the review interrupt
  const reviewed = await graph.invoke(buildOrchestratorRunInput([new HumanMessage('run git status')]), config) as Out;
  const reviewId = reviewed.__interrupt__?.[0]?.id;
  assert.equal(reviewed.__interrupt__?.[0]?.value?.kind, 'review_batch');
  assert.ok(reviewId);

  // 2. reject → the run must SUSPEND on a pause_task interrupt, not end
  const paused = await graph.invoke(new Command({
    resume: { [reviewId]: { decisions: [{ reviewId: 'tool-review:run_shell:call-first', selectedOptionId: 'reject' }] } },
  }), config) as Out;
  const pauseId = paused.__interrupt__?.[0]?.id;
  assert.equal(paused.__interrupt__?.[0]?.value?.kind, 'pause_task', 'pause must surface as a real interrupt');
  assert.ok(pauseId, 'pause interrupt must carry an id');
  const pausedState = await graph.getState(config);
  assert.equal(pausedState.next?.[0], 'pauseGate');
  assert.equal(currentSupervisorTask(pausedState.values.runSupervisorState)?.status, 'pending');
  assert.equal(readCapabilityExecutions(pausedState.values.messages).at(-1)?.result?.status, 'paused', 'result committed before suspension');
  assert.equal(runCount, 0);
  assert.equal(routeCallCount, 2);
  assert.equal(recorder.subagentInputs.length, 1);

  // 3. continue by id → Supervisor considers guidance before re-entering the delegation
  const continued = await graph.invoke(new Command({ resume: { [pauseId]: { action: 'continue', guidance: 'Skip git status; inspect recent commits.' } } }), config) as Out;
  assert.equal(continued.__interrupt__?.[0]?.value?.kind, 'review_batch', 'the continued subagent reaches its next reviewed tool call');
  assert.equal(recorder.subagentInputs.length, 2, 'continue is one fresh subagent invocation');
  assert.equal(routeCallCount, 3, 'guidance must reach Supervisor before continuing');
  assert.equal(runCount, 0);
  const continuedState = await graph.getState(config);
  assert.equal(readCapabilityExecutions(continuedState.values.messages).at(-1)?.result, null, 'continued call awaits its own result');
  const guidance = (continuedState.values.messages as BaseMessage[]).find((message) =>
    HumanMessage.isInstance(message) && message.text === 'Skip git status; inspect recent commits.');
  assert.ok(guidance);
  assert.equal(getAgentMessageMetadata(guidance).traceId, continuedState.values.traceId);
  assert.equal(getAgentMessageRunId(guidance), continuedState.values.runId);
  assert.equal(currentSupervisorTask(continuedState.values.runSupervisorState)?.id, currentSupervisorTask(pausedState.values.runSupervisorState)?.id);
});

for (const continuePlan of [false, true]) {
  test(`cancelled work stays factual and the next run enters Entry before ${continuePlan ? 'continuing' : 'answering'}`, async () => {
    let toolRuns = 0;
    let entryCalls = 0;
    let supervisorCalls = 0;
    const controller = new AbortController();
    const rawTool = tool(async () => {
      toolRuns++;
      controller.abort();
      throw Object.assign(new Error('Execution cancelled.'), { name: 'AbortError' });
    }, { name: 'run_shell', description: 'Run shell.', schema: z.object({}) });
    const registry = compileAgentRegistry({
      toolkits: [{ name: 'local', description: 'Local tools.', tools: [{ tool: rawTool }] }],
      capabilities: [capability('general', 'General work.', ['local'])],
    });
    const entry = { bindTools: () => ({ invoke: async () => {
      entryCalls++;
      if (entryCalls > 1 && !continuePlan) return new AIMessage('No further execution requested.');
      return new AIMessage({ content: '', tool_calls: [{
        id: `entry-${entryCalls}`, name: entryCalls === 1 ? 'plan_request' : 'continue',
        args: entryCalls === 1 ? { goal: 'Inspect and report.' } : {},
      }] });
    } }) } as unknown as AgentModels['act'];
    const graph = createRuntimeOrchestratorGraph({
      models: { act: entry, answer: entry, subagent: new FakeToolCallingModel({
        toolCalls: [[{ id: 'cancelled-tool', name: 'run_shell', args: {} }]],
      }) },
      checkpoint: new MemorySaver(),
      runSupervisorRunner: withScriptedDelegation({ invoke: async (input) => {
        supervisorCalls++;
        if(supervisorCalls === 1) return {
          name: 'submit_plan', args: {
            tasks: [
              { capability: 'general', task: 'Inspect.' }, { capability: 'general', task: 'Report.' },
            ]
          }
        };
        assert.equal(input.mode, 'boundary');
        assert.deepEqual(input.state.plan.map((task) => task.task), ['Inspect.', 'Report.']);
        return { reply: 'The previous execution was cancelled; please clarify the remaining work.' };
      } }),
    });
    const config = { configurable: { thread_id: `cancel-${continuePlan}`, registry } };
    await assert.rejects(graph.invoke(buildOrchestratorRunInput([new HumanMessage('Inspect and report.')]),
      { ...config, signal: controller.signal }));
    const cancelled = await graph.getState(config);
    assert.equal(toolRuns, 1);
    assert.equal(cancelled.values.runSupervisorState.plan[0].status, 'pending');
    assert.deepEqual(await settleAbortedRun({
      getState: () => graph.getState(config),
    }), { status: 'finished' });
    const next = await graph.invoke(buildOrchestratorRunInput([new HumanMessage('What remains?')]), config);
    assert.equal(entryCalls, 2);
    assert.equal(supervisorCalls, continuePlan ? 2 : 1);
    assert.equal(toolRuns, 1);
    assert.notEqual(next.runId, cancelled.values.runId);
    assert.deepEqual(next.runSupervisorState, cancelled.values.runSupervisorState);
  });
}
