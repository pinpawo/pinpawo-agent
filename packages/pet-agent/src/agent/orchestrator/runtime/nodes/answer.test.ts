import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { AgentModels } from '../../../../types/agent';
import { setPinpetMeta } from '../../messageLanes';
import type { OrchestratorStateType } from '../../state';
import {
  createAnswerNode,
  GOAL_DONE_ACKNOWLEDGEMENT,
  selectAnswerContextFacts,
} from './answer';

function state(
  patch: Partial<OrchestratorStateType> = {},
): OrchestratorStateType {
  return {
    messages: [],
    taskActiveDelegation: null,
    runPendingTask: null,
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

test('goal_done returns a fixed acknowledgement without invoking the Answer model', async () => {
  let modelInvocations = 0;
  const model = {
    invoke: async () => {
      modelInvocations += 1;
      return new AIMessage('不应调用');
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

  assert.equal(modelInvocations, 0);
  assert.equal(output, GOAL_DONE_ACKNOWLEDGEMENT);
  assert.doesNotMatch(output, /浏览器|账号主页|等待页面|提取昵称/);
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
