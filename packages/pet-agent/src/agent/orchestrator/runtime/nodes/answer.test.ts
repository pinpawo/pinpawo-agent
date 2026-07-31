import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanMessage } from '@langchain/core/messages';
import type { OrchestratorStateType } from '../../state';
import { selectAnswerContextFacts } from './answer';

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
