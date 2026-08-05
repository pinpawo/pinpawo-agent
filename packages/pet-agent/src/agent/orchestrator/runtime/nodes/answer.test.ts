import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { AgentModels } from '../../../../types/agent';
import { setPinpetMeta } from '../../messageLanes';
import type { OrchestratorStateType } from '../../state';
import {
  createAnswerNode,
  selectAnswerContextFacts,
} from './answer';

function state(
  patch: Partial<OrchestratorStateType> = {},
): OrchestratorStateType {
  return {
    messages: [],
    taskActiveDelegation: null,
    runPlannerReturn: null,
    runNextDelegation: null,
    runIterationCount: 0,
    ...patch,
  } as OrchestratorStateType;
}

test('Answer runtime projects accepted terminal meaning into closed facts', () => {
  const history = [new HumanMessage('完成当前任务')];

  assert.deepEqual(selectAnswerContextFacts({
    state: state(),
    history,
    acceptedHandoffOutcome: 'goal_done',
    awaitingUserInput: false,
    runIterationLimit: 4,
  }), {
    mode: 'goal_done',
    hasUserGoal: true,
  });

  assert.deepEqual(selectAnswerContextFacts({
    state: state(),
    history,
    acceptedHandoffOutcome: null,
    awaitingUserInput: true,
    runIterationLimit: 4,
  }), {
    mode: 'user_input_required',
    hasUserGoal: true,
  });
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
    runLatestDelegationOutcome: 'goal_done',
  }));
  const output = String(result.messages?.at(-1)?.content ?? '');

  assert.equal(modelInvocations, 1);
  assert.equal(output, summary);
  assert.match(String(invocationMessages[2]?.content), /公开信息已经提取并结构化返回/);
  assert.match(String(invocationMessages.at(-1)?.content), /<reply_mode>goal_done<\/reply_mode>/);
  assert.match(String(invocationMessages.at(-1)?.content), /<user_goal_present>true<\/user_goal_present>/);
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
        status: 'awaiting_decision',
        resultPreview: null,
      },
    }),
    history: [new HumanMessage('检查仓库')],
    acceptedHandoffOutcome: null,
    awaitingUserInput: false,
    runIterationLimit: 4,
  });

  assert.deepEqual(facts, {
    mode: 'blocked',
    hasUserGoal: true,
    reason: 'iteration_limit',
    unfinishedTask: '检查剩余文件',
    detail: null,
  });
  assert.equal('replyInstruction' in facts, false);
});
