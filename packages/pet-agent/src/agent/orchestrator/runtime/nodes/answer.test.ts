import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentModels } from '../../../../types/agent';
import { setPinpetMeta } from '../../messageLanes';
import type { OrchestratorStateType } from '../../state';
import {
  createAnswerNode,
  projectAcceptedRunResults,
  selectAnswerContextFacts,
} from './answer';

function state(
  patch: Partial<OrchestratorStateType> = {},
): OrchestratorStateType {
  return {
    messages: [],
    taskActiveDelegation: null,
    runNextDelegation: null,
    runIterationCount: 0,
    ...patch,
  } as OrchestratorStateType;
}

test('Answer runtime projects accepted terminal meaning into closed facts', () => {
  const history = [new HumanMessage('完成当前任务')];
  const acceptedResults = [{
    task: '检查配置',
    result: '配置检查已完成。',
    artifactRefs: [],
  }];

  assert.deepEqual(selectAnswerContextFacts({
    state: state(),
    history,
    acceptedHandoffOutcome: 'goal_done',
    acceptedResults,
    awaitingUserInput: false,
    runIterationLimit: 4,
  }), {
    mode: 'goal_done',
    hasUserRequest: true,
    acceptedResults,
  });

  assert.deepEqual(selectAnswerContextFacts({
    state: state(),
    history,
    acceptedHandoffOutcome: null,
    acceptedResults,
    awaitingUserInput: true,
    runIterationLimit: 4,
  }), {
    mode: 'user_input_required',
    hasUserRequest: true,
    acceptedResults,
    question: null,
    context: null,
  });
});

test('Answer runtime recognizes the run user request when canonical history has no current request', () => {
  assert.deepEqual(selectAnswerContextFacts({
    state: state({
      runUserRequest: '总结已经完成的仓库检查。\n\n只报告当前工作区结果。',
    }),
    history: [new AIMessage('仓库检查已经完成。')],
    acceptedHandoffOutcome: 'goal_done',
    acceptedResults: [],
    awaitingUserInput: false,
    runIterationLimit: 4,
  }), {
    mode: 'goal_done',
    hasUserRequest: true,
    acceptedResults: [],
  });
});

test('Answer projects only current-run completed handoffs in delegation order', () => {
  const historical = new AIMessage('旧 run 的结果。');
  setPinpetMeta(historical, {
    handoffFrom: 'capability:general',
    delegationId: 'old-delegation',
    runId: 'old-run',
    task: '旧任务',
    announceMessageId: 'old-announce',
  });
  const second = new AIMessage('第二项结果。');
  setPinpetMeta(second, {
    handoffFrom: 'capability:general',
    delegationId: 'delegation-2',
    runId: 'run-2',
    task: '提交 PR',
    announceMessageId: 'announce-2',
  });
  const first = new AIMessage('第一项结果。');
  setPinpetMeta(first, {
    handoffFrom: 'capability:explore',
    delegationId: 'delegation-1',
    runId: 'run-1',
    task: '审查风险',
    announceMessageId: 'announce-1',
  });
  const supersededFirst = new AIMessage('第一项旧副本。');
  setPinpetMeta(supersededFirst, {
    handoffFrom: 'capability:explore',
    delegationId: 'delegation-1',
    runId: 'run-1',
    task: '审查风险',
    announceMessageId: 'announce-1',
  });
  const delegationStarted = new AIMessage('开始执行计划任务：审查风险');
  setPinpetMeta(delegationStarted, {
    source: 'delegation_started',
    delegationId: 'delegation-1',
    runId: 'run-1',
    task: '审查风险',
  });
  const projection = projectAcceptedRunResults({
    state: state({
      runDelegationSummaries: [
        {
          id: 'delegation-1',
          lane: 'capability:explore',
          task: '审查风险',
          status: 'completed',
          resultPreview: '第一项结果。',
        },
        {
          id: 'delegation-2',
          lane: 'capability:general',
          task: '提交 PR',
          status: 'completed',
          resultPreview: '第二项结果。',
        },
      ],
      sessionCapabilityArtifacts: [{
        id: 'artifact-2',
        threadId: 'thread-1',
        capabilityId: 'general',
        delegationId: 'delegation-2',
        runId: 'run-2',
        kind: 'report',
        mimeType: 'text/markdown',
        uri: 'pinpawo://artifact/pr.md',
        title: 'PR 报告',
        sizeBytes: 42,
        createdAt: '2026-08-16T00:00:00.000Z',
      }],
    }),
    history: [
      new HumanMessage('完成发布准备'),
      historical,
      supersededFirst,
      delegationStarted,
      second,
      first,
    ],
  });

  assert.deepEqual(projection.results.map(({ task, result }) => ({ task, result })), [
    { task: '审查风险', result: '第一项结果。' },
    { task: '提交 PR', result: '第二项结果。' },
  ]);
  assert.equal(projection.results[1]?.artifactRefs[0]?.uri, 'pinpawo://artifact/pr.md');
  assert.equal(projection.history.length, 2);
  assert.ok(projection.history[0] instanceof HumanMessage);
  assert.strictEqual(projection.history[1], historical);
  assert.match(String(projection.history[1]?.content), /旧 run/);
});

test('goal_done asks Answer to summarize the completed task from canonical history', async () => {
  let modelInvocations = 0;
  let invocationMessages: BaseMessage[] = [];
  const summary = '账号公开信息整理已完成：已提取昵称、简介、公开指标和可见内容，并形成结构化结果。';
  const model = {
    invoke: async (messages: BaseMessage[]) => {
      modelInvocations += 1;
      invocationMessages = messages;
      return new AIMessage(summary);
    },
  } as unknown as AgentModels['act'];
  const completedTask = [
    '使用浏览器打开已脱敏的账号主页，复用登录态，等待页面渲染，',
    '然后提取昵称、简介和公开内容。',
  ].join('');
  const handoff = new AIMessage('公开信息已经提取并结构化返回。');
  setPinpetMeta(handoff, {
    handoffFrom: 'capability:explore',
    delegationId: 'delegation-browser',
    runId: 'run-browser',
    task: completedTask,
    announceMessageId: 'announce-browser',
  });
  const answerNode = createAnswerNode({
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

  const result = await answerNode(state({
    messages: [new HumanMessage('提取这个账号的公开信息'), handoff],
    runDelegationSummaries: [{
      id: 'delegation-browser',
      lane: 'capability:explore',
      task: completedTask,
      status: 'completed',
      resultPreview: '公开信息已经提取并结构化返回。',
    }],
    sessionCapabilityArtifacts: [],
    runLatestDelegationOutcome: 'goal_done',
  }));
  const output = String(result.messages?.at(-1)?.content ?? '');

  assert.equal(modelInvocations, 1);
  assert.equal(output, summary);
  assert.equal(invocationMessages.some((message) => message === handoff), false);
  assert.match(String(invocationMessages.at(-1)?.content), /公开信息已经提取并结构化返回/);
  assert.match(String(invocationMessages.at(-1)?.content), /<reply_mode>goal_done<\/reply_mode>/);
  assert.match(String(invocationMessages.at(-1)?.content), /<user_request_present>true<\/user_request_present>/);
  assert.doesNotMatch(String(invocationMessages[0]?.content), /账号主页|等待页面|提取昵称/);
  assert.equal(result.runLatestDelegationOutcome, null);
});

test('Answer runtime projects unfinished work as facts rather than prose', () => {
  const facts = selectAnswerContextFacts({
    state: state({
      runIterationCount: 4,
      taskActiveDelegation: {
        id: 'delegation-1',
        lane: 'capability:general',
        task: '检查剩余文件',
        contextSummary: null,
        transcriptRunId: 'run-1',
        traceId: 'trace-1',
        status: 'awaiting_decision',
        resultPreview: null,
        userRequest: '检查仓库',
      },
    }),
    history: [new HumanMessage('检查仓库')],
    acceptedHandoffOutcome: null,
    acceptedResults: [],
    awaitingUserInput: false,
    runIterationLimit: 4,
  });

  assert.deepEqual(facts, {
    mode: 'blocked',
    hasUserRequest: true,
    acceptedResults: [],
    reason: 'iteration_limit',
    unfinishedTask: '检查剩余文件',
    detail: null,
  });
  assert.equal('replyInstruction' in facts, false);
});
