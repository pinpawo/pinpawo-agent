import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import { getAnswerEvalScenarios } from './answer-eval-scenarios.ts';

function answerModel(text: string) {
  return { invoke: async () => new AIMessage(text) } as never;
}

test('answer eval renders the production prompt and fixed completion context', () => {
  const scenario = getAnswerEvalScenarios().find(
    ({ caseName }) => caseName === 'delegation-completion-acknowledgement',
  );
  assert.ok(scenario);
  const text = scenario.render().map((message) => String(message.content)).join('\n');
  assert.match(text, /orchestrator 的最终回复节点/);
  assert.match(text, /delegation completion acknowledgement/);
  assert.match(text, /delegated task：汇总本周发布风险/);
  assert.match(text, /RESULT_BODY_START/);
});

test('answer eval distinguishes requested historical replay from completion-body repetition', async () => {
  const replay = getAnswerEvalScenarios().find(({ caseName }) => caseName === 'historical-replay');
  const completion = getAnswerEvalScenarios().find(
    ({ caseName }) => caseName === 'delegation-completion-acknowledgement',
  );
  assert.ok(replay);
  assert.ok(completion);

  const replayResult = await replay.run(answerModel('ARCHIVE_RESULT_731；回滚窗口为 30 分钟。'));
  assert.ok(replayResult.scores.every(({ score }) => score === 1));

  const completionResult = await completion.run(answerModel('本周发布风险已汇总完成，如需继续处理请告诉我。'));
  assert.ok(completionResult.scores.every(({ score }) => score === 1));
  const repeatedResult = await completion.run(answerModel(
    '完成。完整风险正文：database-freeze-42；queue-drain-88；建议分三阶段切流。',
  ));
  assert.equal(
    repeatedResult.scores.find(({ key }) => key === 'forbidden_content_absent')?.score,
    0,
  );
  assert.equal(
    repeatedResult.scores.find(({ key }) => key === 'prior_result_repetition_correct')?.score,
    0,
  );
});
