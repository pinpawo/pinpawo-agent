import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import { getResultSynthesisEvalScenarios } from './result-synthesis-eval-scenarios.ts';
import { buildPromptGoalEvaluatorPrompt } from './prompt-goal-evaluator.ts';

function evaluatorModel(text: string, unmetCriteria: string[] = []) {
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

test('result synthesis evaluator exposes its schema to jsonMode providers', () => {
  const prompt = buildPromptGoalEvaluatorPrompt('jsonMode', ['criterion_one', 'criterion_two']);
  assert.match(prompt, /Return one JSON object matching this schema/);
  assert.match(prompt, /"criteria"/);
  assert.match(prompt, /"criterion_one"/);
});

test('result synthesis eval covers only multi-result goal composition', async () => {
  const scenarios = getResultSynthesisEvalScenarios();
  assert.equal(scenarios.length, 1);
  const scenario = scenarios[0];
  assert.equal(scenario?.target, 'result_synthesis');
  assert.equal(scenario?.caseName, 'multi-handoff-compression');
  const messages = scenario?.render() ?? [];
  const input = String(messages.at(-1)?.content ?? '');

  assert.deepEqual(messages.map((message) => message._getType()), ['system', 'human']);
  assert.match(input, /^<result_synthesis_input/);
  assert.match(input, /<accepted_result order="1">/);
  assert.match(input, /<accepted_result order="2">/);
  assert.match(input, /<accepted_result order="3">/);
  assert.doesNotMatch(input, /reply_mode|answer_context/);

  const summary = '发布准备已完成：cache-key-17 已修复，resume 测试通过，PR #643 已创建且没有剩余阻塞项。';
  const result = await scenario?.run({
    invoke: async () => new AIMessage(summary),
  } as never, undefined, {
    model: evaluatorModel('judge'),
  });
  assert.equal(result?.output.text, summary);
  assert.equal(result?.verdict, 'compressed_task_summary');
});

test('result synthesis goal judgment remains independent from diagnostics', async () => {
  const scenario = getResultSynthesisEvalScenarios()[0];
  assert.ok(scenario);
  const result = await scenario.run(evaluatorModel(
    '发布准备已经完成。',
    ['key_cross_handoff_facts_preserved'],
  ));

  assert.equal(
    result.scores.find(({ key }) => key === 'key_cross_handoff_facts_preserved')?.score,
    0,
  );
  assert.equal(result.verdict, 'goal_not_achieved');
});
