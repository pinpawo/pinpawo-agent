import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import { getAnswerEvalScenarios } from './answer-eval-scenarios.ts';
import { buildPromptGoalEvaluatorPrompt } from './prompt-goal-evaluator.ts';

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
  const prompt = buildPromptGoalEvaluatorPrompt('jsonMode', ['criterion_one', 'criterion_two']);
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
  assert.deepEqual(messages.map((message) => message._getType()), ['system', 'human', 'ai']);
  const systemText = String(messages[0].content);
  const resultText = String(messages[2].content);
  assert.match(systemText, /本次回复目标/);
  assert.match(systemText, /汇总本周发布风险/);
  assert.doesNotMatch(systemText, /orchestrator|handoff|delegation|subagent/);
  assert.match(resultText, /RESULT_BODY_START/);
});

test('answer eval renders the current user goal for an ordinary reply', () => {
  const scenario = getAnswerEvalScenarios().find(({ caseName }) => caseName === 'direct-answer');
  assert.ok(scenario);
  const messages = scenario.render();
  assert.deepEqual(messages.map((message) => message._getType()), ['system', 'human']);
  const systemText = String(messages[0].content);
  assert.match(systemText, /主对话中最近一条用户消息所表达的目标/);
  assert.doesNotMatch(systemText, /只回答这个问题：2 \+ 3 等于多少/);
  assert.equal(String(messages[1].content), '只回答这个问题：2 + 3 等于多少？');
});

test('answer eval derives goal result from evaluator criteria', async () => {
  const completion = getAnswerEvalScenarios().find(
    ({ caseName }) => caseName === 'delegation-completion-acknowledgement',
  );
  assert.ok(completion);

  const result = await completion.run(answerModel(
    '完成。完整风险正文：database-freeze-42；queue-drain-88；建议分三阶段切流。',
    ['delivered_body_not_repeated'],
  ));
  assert.equal(
    result.scores.find(({ key }) => key === 'delivered_body_not_repeated')?.score,
    0,
  );
  assert.ok(result.scores.every(({ evaluator }) => evaluator === 'llm-judge'));
  assert.ok(result.scores.every(({ statement }) => statement.trim()));
  assert.equal(result.verdict, 'goal_not_achieved');
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
