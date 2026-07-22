import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import { getAnswerEvalScenarios } from './answer-eval-scenarios.ts';

function answerModel(text: string, unmetCriteria: string[] = []) {
  return {
    invoke: async () => new AIMessage(text),
    withStructuredOutput: () => ({
      invoke: async (messages: Array<{ content: unknown }>) => {
        const input = JSON.parse(String(messages.at(-1)?.content)) as {
          acceptanceCriteria: Array<{ id: string }>;
        };
        return {
          criteria: input.acceptanceCriteria.map(({ id }) => ({
            id,
            met: !unmetCriteria.includes(id),
            reason: unmetCriteria.includes(id) ? 'criterion not met' : 'criterion met',
          })),
          summary: unmetCriteria.length === 0 ? 'goal achieved' : 'goal not achieved',
        };
      },
    }),
  } as never;
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
    ['delivered_body_not_repeated'],
  ));
  assert.equal(
    repeatedResult.scores.find(({ key }) => key === 'delivered_body_not_repeated')?.score,
    0,
  );
  assert.equal(repeatedResult.verdict, 'goal_not_achieved');
  assert.ok(Number(repeatedResult.diagnostics.longestPriorAssistantVerbatimSpan) > 24);
});

test('answer diagnostics do not decide whether the objective was achieved', async () => {
  const clarification = getAnswerEvalScenarios().find(
    ({ caseName }) => caseName === 'clarification-question',
  );
  assert.ok(clarification);
  const result = await clarification.run(answerModel(`请提供目标环境和需要修改的配置项。${'补充说明。'.repeat(60)}`));
  assert.ok(result.scores.every(({ score }) => score === 1));
  assert.equal(result.verdict, 'ask_user');
  assert.equal(result.diagnostics.withinReferenceLength, false);
});
