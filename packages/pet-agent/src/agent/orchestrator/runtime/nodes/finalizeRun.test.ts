import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentModels } from '../../../../types/agent';
import { DelegationAnnounceMessage } from '../../delegationAnnounce';
import { setPinpetMeta } from '../../messageLanes';
import type { OrchestratorStateType } from '../../state';
import {
  CHECKPOINT_INCOMPATIBLE_MESSAGE,
  createFinalizeRunNode,
  collectAcceptedRunResults,
} from './finalizeRun';

function state(patch: Partial<OrchestratorStateType> = {}): OrchestratorStateType {
  return {
    messages: [],
    taskActiveDelegation: null,
    taskPlannerContinuation: null,
    runNextDelegation: null,
    runPlannerSession: null,
    runDelegationSummaries: [],
    runIterationCount: 0,
    runTerminalOutcome: null,
    sessionCapabilityArtifacts: [],
    ...patch,
  } as OrchestratorStateType;
}

function announce(params: {
  id: string;
  sourceLane: `capability:${string}`;
  delegationId: string;
  transcriptRunId: string;
  task: string;
  result: string;
}) {
  return new DelegationAnnounceMessage({
    ...params,
    announceMessageId: params.id,
    completionReason: 'natural',
    createdAt: '2026-08-29T00:00:00.000Z',
  });
}

function nonInvokableModel() {
  return {
    invoke: async () => {
      throw new Error('model must not be invoked');
    },
  } as unknown as AgentModels['act'];
}

test('finalizeRun preserves a Planner direct response without invoking another model', async () => {
  const directResponse = '能看到 `wiki/DEMO.md`。\n\n这个 demo 通过 `curl` 调用。';
  const finalizeRun = createFinalizeRunNode({
    models: { act: nonInvokableModel() },
  });
  const result = await finalizeRun(state({
    runTerminalOutcome: {
      kind: 'direct_response',
      source: 'capability_planner',
      content: directResponse,
    },
  }));

  assert.equal(String(result.messages?.at(-1)?.content), directResponse);
  assert.equal(result.runTerminalOutcome, null);
});

test('finalizeRun renders user input requests from structured state', async () => {
  const active = {
    id: 'delegation-1',
    lane: 'capability:general' as const,
    task: '部署应用',
    contextSummary: null,
    transcriptRunId: 'run-1',
    traceId: 'trace-1',
    status: 'awaiting_decision' as const,
    resultPreview: '部署前检查完成。',
    userRequest: '部署应用',
  };
  const finalizeRun = createFinalizeRunNode({
    models: { act: nonInvokableModel() },
  });
  const progress = new AIMessage({ id: 'announce-1', content: '部署前检查已完成。' });
  setPinpetMeta(progress, {
    lane: active.lane,
    runId: active.transcriptRunId,
    delegationId: active.id,
    isAnnounce: true,
    completionReason: 'natural',
    task: active.task,
  });
  const result = await finalizeRun(state({
    messages: [progress],
    taskActiveDelegation: active,
    runTerminalOutcome: {
      kind: 'user_input_required',
      question: '请选择生产或预发布环境。',
    },
  }));
  const content = String(result.messages?.at(-1)?.content);

  assert.match(content, /部署前检查已完成/);
  assert.match(content, /请选择生产或预发布环境/);
  assert.equal(result.taskActiveDelegation, undefined);
  assert.equal(result.runTerminalOutcome, null);
});

test('finalizeRun returns one accepted result directly without model synthesis', async () => {
  const handoff = announce({
    id: 'announce-1',
    sourceLane: 'capability:general',
    delegationId: 'delegation-1',
    transcriptRunId: 'run-1',
    task: '查看 demo',
    result: 'demo 已检查完成。',
  });
  const finalizeRun = createFinalizeRunNode({
    models: { act: nonInvokableModel() },
  });
  const result = await finalizeRun(state({
    messages: [new HumanMessage('查看 demo'), handoff],
    runDelegationSummaries: [{
      id: 'delegation-1',
      lane: 'capability:general',
      task: '查看 demo',
      status: 'completed',
      resultPreview: 'demo 已检查完成。',
    }],
    runTerminalOutcome: { kind: 'goal_done' },
  }));

  assert.equal(String(result.messages?.at(-1)?.content), 'demo 已检查完成。');
});

test('finalizeRun invokes result synthesis only for multiple accepted results', async () => {
  let invocations = 0;
  let invocationMessages: BaseMessage[] = [];
  const model = {
    invoke: async (messages: BaseMessage[]) => {
      invocations += 1;
      invocationMessages = messages;
      return new AIMessage('两项工作均已完成。');
    },
  } as unknown as AgentModels['act'];
  const first = announce({
    id: 'announce-1',
    sourceLane: 'capability:general',
    delegationId: 'delegation-1',
    transcriptRunId: 'run-1',
    task: '检查配置',
    result: '配置正常。',
  });
  const second = announce({
    id: 'announce-2',
    sourceLane: 'capability:release',
    delegationId: 'delegation-2',
    transcriptRunId: 'run-2',
    task: '验证发布',
    result: '发布验证通过。',
  });
  const finalizeRun = createFinalizeRunNode({
    models: { act: model },
    actor: {
      petId: 'pet-1',
      userId: 'user-1',
      name: '小白',
      personality: null,
      stage: null,
      species: null,
    },
  });
  const result = await finalizeRun(state({
    messages: [new HumanMessage('完成发布准备'), first, second],
    runUserRequest: '完成发布准备',
    runDelegationSummaries: [
      {
        id: 'delegation-1',
        lane: 'capability:general',
        task: '检查配置',
        status: 'completed',
        resultPreview: '配置正常。',
      },
      {
        id: 'delegation-2',
        lane: 'capability:release',
        task: '验证发布',
        status: 'completed',
        resultPreview: '发布验证通过。',
      },
    ],
    runTerminalOutcome: { kind: 'goal_done' },
  }));

  assert.equal(invocations, 1);
  assert.equal(String(result.messages?.at(-1)?.content), '两项工作均已完成。');
  assert.deepEqual(invocationMessages.map((message) => message._getType()), ['system', 'human']);
  assert.match(String(invocationMessages.at(-1)?.content), /<result_synthesis_input/);
  assert.doesNotMatch(String(invocationMessages.at(-1)?.content), /reply_mode|answer_context/);
});

test('finalizeRun rejects incompatible checkpoints deterministically', async () => {
  const finalizeRun = createFinalizeRunNode({
    models: { act: nonInvokableModel() },
  });
  const result = await finalizeRun(state({
    taskActiveDelegation: {
      id: 'legacy',
      lane: 'capability:general',
      task: '旧任务',
      contextSummary: null,
      transcriptRunId: 'legacy-run',
      traceId: '',
      status: 'awaiting_decision',
      resultPreview: null,
      userRequest: '',
    },
    runTerminalOutcome: { kind: 'checkpoint_incompatible' },
  }));

  assert.equal(String(result.messages?.at(-1)?.content), CHECKPOINT_INCOMPATIBLE_MESSAGE);
  assert.equal(result.taskActiveDelegation, null);
  assert.equal(result.taskPlannerContinuation, null);
});

test('accepted result collection follows completed delegation order', () => {
  const first = announce({
    id: 'announce-1',
    sourceLane: 'capability:general',
    delegationId: 'delegation-1',
    transcriptRunId: 'run-1',
    task: '第一项',
    result: '第一项结果。',
  });
  const second = announce({
    id: 'announce-2',
    sourceLane: 'capability:release',
    delegationId: 'delegation-2',
    transcriptRunId: 'run-2',
    task: '第二项',
    result: '第二项结果。',
  });
  const results = collectAcceptedRunResults({
    state: state({
      runDelegationSummaries: [
        {
          id: 'delegation-1',
          lane: 'capability:general',
          task: '第一项',
          status: 'completed',
          resultPreview: '第一项结果。',
        },
        {
          id: 'delegation-2',
          lane: 'capability:release',
          task: '第二项',
          status: 'completed',
          resultPreview: '第二项结果。',
        },
      ],
    }),
    history: [new HumanMessage('完成两项工作'), second, first],
  });

  assert.deepEqual(results.map(({ task, result }) => ({ task, result })), [
    { task: '第一项', result: '第一项结果。' },
    { task: '第二项', result: '第二项结果。' },
  ]);
});
