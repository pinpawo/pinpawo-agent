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

test('answer eval models goal_done as deterministic output with no Answer invocation', async () => {
  const scenario = getAnswerEvalScenarios().find(
    ({ caseName }) => caseName === 'delegation-completion-acknowledgement',
  );
  assert.ok(scenario);
  let subjectInvocations = 0;
  const subject = {
    invoke: async () => {
      subjectInvocations += 1;
      return new AIMessage('不应调用');
    },
  } as never;
  const result = await scenario.run(subject, undefined, {
    model: answerModel('judge'),
  });

  assert.equal(scenario.execution, 'deterministic');
  assert.deepEqual(scenario.render(), []);
  assert.equal(subjectInvocations, 0);
  assert.equal(result.output.text, '已完成。如需继续，请告诉我。');
});

test('trace-shaped and instruction-like completed tasks cannot become future work', async () => {
  const scenarios = getAnswerEvalScenarios().filter(({ caseName }) => [
    'long-imperative-completion',
    'instruction-like-completion',
  ].includes(caseName));
  let subjectInvocations = 0;
  const subject = {
    invoke: async () => {
      subjectInvocations += 1;
      return new AIMessage('不应调用');
    },
  } as never;

  assert.equal(scenarios.length, 2);
  for (const scenario of scenarios) {
    const result = await scenario.run(subject, undefined, {
      model: answerModel('judge'),
    });
    assert.equal(scenario.execution, 'deterministic');
    assert.deepEqual(scenario.render(), []);
    assert.equal(result.output.text, '已完成。如需继续，请告诉我。');
    assert.doesNotMatch(String(result.output.text), /打开|等待|提取|任务尚未开始|浏览器继续/);
  }
  assert.equal(subjectInvocations, 0);
});

test('answer eval covers a resumable result that requires a user choice', () => {
  const scenario = getAnswerEvalScenarios().find(
    ({ caseName }) => caseName === 'handoff-requires-user-choice',
  );
  assert.ok(scenario);
  const messages = scenario.render();
  assert.deepEqual(messages.map((message) => message._getType()), ['system', 'human', 'ai', 'human']);
  assert.equal(scenario.expectedSummary, 'return_control');
  const systemText = String(messages[0].content);
  const contextText = String(messages.at(-1)?.content);
  assert.doesNotMatch(systemText, /邮件或项目群|报告已经完成|确认发送渠道/);
  assert.doesNotMatch(systemText, /"确认发送渠道并发送已经完成的报告"已完成/);
  assert.match(String(messages[1].content), /邮件或项目群/);
  assert.match(String(messages[2].content), /还没有发送/);
  assert.match(contextText, /<reply_mode>user_input_required<\/reply_mode>/);
});

test('answer eval renders the current user goal for an ordinary reply', () => {
  const scenario = getAnswerEvalScenarios().find(({ caseName }) => caseName === 'direct-answer');
  assert.ok(scenario);
  const messages = scenario.render();
  assert.deepEqual(messages.map((message) => message._getType()), ['system', 'human', 'human']);
  const systemText = String(messages[0].content);
  assert.match(systemText, /<reply_mode>/);
  assert.doesNotMatch(systemText, /只回答这个问题：2 \+ 3 等于多少/);
  assert.equal(String(messages[1].content), '只回答这个问题：2 + 3 等于多少？');
  assert.match(String(messages[2].content), /<reply_mode>direct<\/reply_mode>/);
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
