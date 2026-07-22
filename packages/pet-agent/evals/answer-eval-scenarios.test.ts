import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import {
  buildAnswerGoalEvaluatorPrompt,
  getAnswerEvalScenarios,
} from './answer-eval-scenarios.ts';

function answerModel(text: string, unmetCriteria: string[] = []) {
  return {
    invoke: async () => new AIMessage(text),
    withStructuredOutput: () => ({
      invoke: async (messages: Array<{ content: unknown }>) => {
        const input = JSON.parse(String(messages.at(-1)?.content)) as {
          acceptanceCriteria: Array<{ id: string }>;
        };
        return {
          criteria: Object.fromEntries(input.acceptanceCriteria.map(({ id }) => [id, {
            met: !unmetCriteria.includes(id),
            reason: unmetCriteria.includes(id) ? 'criterion not met' : 'criterion met',
          }])),
          summary: unmetCriteria.length === 0 ? 'goal achieved' : 'goal not achieved',
        };
      },
    }),
  } as never;
}

test('answer evaluator exposes its schema to jsonMode providers', () => {
  const prompt = buildAnswerGoalEvaluatorPrompt('jsonMode', ['criterion_one', 'criterion_two']);
  assert.match(prompt, /Return one JSON object matching this schema/);
  assert.match(prompt, /"criteria"/);
  assert.match(prompt, /"met"/);
  assert.match(prompt, /"summary"/);
  assert.match(prompt, /"criterion_one"/);
  assert.match(prompt, /"criterion_two"/);
});

test('answer eval renders the production prompt and fixed completion context', () => {
  const scenario = getAnswerEvalScenarios().find(
    ({ caseName }) => caseName === 'delegation-completion-acknowledgement',
  );
  assert.ok(scenario);
  const messages = scenario.render();
  const text = messages.map((message) => String(message.content)).join('\n');
  assert.deepEqual(messages.map((message) => message._getType()), ['system', 'human', 'ai']);
  assert.match(text, /本次用户目标（已完成）/);
  assert.match(text, /汇总本周发布风险/);
  assert.match(text, /上一条消息已经完整呈现工作结果/);
  assert.match(text, /使用以下结束说明/);
  assert.match(text, /"汇总本周发布风险"已完成。如需继续，请告诉我/);
  assert.doesNotMatch(text, /orchestrator|handoff|delegation|subagent/);
  assert.match(text, /RESULT_BODY_START/);
});

test('answer eval renders the current user goal for an ordinary reply', () => {
  const scenario = getAnswerEvalScenarios().find(({ caseName }) => caseName === 'direct-answer');
  assert.ok(scenario);
  const text = scenario.render().map((message) => String(message.content)).join('\n');
  assert.match(text, /本次用户目标（引用）/);
  assert.match(text, /只回答这个问题：2 \+ 3 等于多少/);
  assert.match(text, /根据主对话已有信息完成该用户目标/);
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
