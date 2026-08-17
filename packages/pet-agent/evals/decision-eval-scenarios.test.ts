import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import { getDecisionEvalScenarios } from './decision-eval-scenarios.ts';
import { summarizeDecisionStability } from './decision-stability.ts';
import { measureDecisionPrompt } from './prompt-preview.ts';

function textModel(output: string) {
  return {
    invoke: async () => new AIMessage(output),
    bindTools: () => ({ invoke: async () => new AIMessage(output) }),
  } as never;
}

test('decision eval scenarios cover every canonical prompt distribution', () => {
  assert.deepEqual({
    entryAnswer: getDecisionEvalScenarios('entry_answer').length,
  }, { entryAnswer: 5 });
});

test('decision eval scenarios render complete production messages', () => {
  for (const scenario of getDecisionEvalScenarios()) {
    const prompt = scenario.render();
    assert.ok(prompt.system.trim());
    assert.equal(prompt.input, '');
    assert.doesNotMatch(
      `${prompt.system}\n${prompt.input}`,
      /\{(?:config|sharedPrefix|outputInstruction|\w+Block)\}/,
    );
    const metrics = measureDecisionPrompt(prompt);
    assert.ok(metrics.totalChars >= prompt.system.length + prompt.input.length + 1);
    assert.ok(prompt.conversationMessages?.length);
    assert.equal(prompt.conversationMessages?.at(-1)?._getType(), 'human');
    assert.ok(metrics.approximateTokens > 0);
  }
});

test('decision stability summary separates schema and invocation failures', () => {
  const summary = summarizeDecisionStability([
    {
      target: 'entry_answer', caseId: 'case-1', contract: 'entry_answer.route', objective: 'Route the request.', repeat: 1, goalAchieved: true, durationMs: 10,
      verdict: 'goal_done', outputShape: 'gapNote=0', outputFingerprint: 'a', criteria: [], failedCriteria: [], diagnostics: {}, failureKind: null, error: null,
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, estimatedCostUsd: 0.001,
      evaluationUsage: null, evaluationEstimatedCostUsd: null,
    },
    {
      target: 'entry_answer', caseId: 'case-1', contract: 'entry_answer.route', objective: 'Route the request.', repeat: 2, goalAchieved: false, durationMs: 20,
      verdict: 'task_done', outputShape: 'gapNote=1', outputFingerprint: 'b', criteria: [], failedCriteria: ['outcome_correct'], diagnostics: {}, failureKind: null, error: null,
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 }, estimatedCostUsd: 0.002,
      evaluationUsage: null, evaluationEstimatedCostUsd: null,
    },
    {
      target: 'entry_answer', caseId: 'case-1', contract: 'entry_answer.route', objective: 'Route the request.', repeat: 3, goalAchieved: null, durationMs: 30,
      verdict: null, outputShape: null, outputFingerprint: null, criteria: [], failedCriteria: [], diagnostics: {}, failureKind: 'schema', error: 'invalid output',
      usage: null, estimatedCostUsd: null,
      evaluationUsage: null, evaluationEstimatedCostUsd: null,
    },
  ])[0];
  assert.equal(summary.goalsAchieved, 1);
  assert.equal(summary.goalsNotAchieved, 1);
  assert.equal(summary.goalsNotEvaluable, 1);
  assert.equal(summary.schemaFailures, 1);
  assert.equal(summary.invokeFailures, 0);
  assert.equal(summary.outputVariants, 2);
  assert.equal(summary.meanDurationMs, 20);
  assert.deepEqual(summary.verdictDistribution, { goal_done: 1, task_done: 1, error: 1 });
  assert.deepEqual(summary.outputShapeDistribution, { 'gapNote=0': 1, 'gapNote=1': 1, error: 1 });
  assert.deepEqual(summary.failedCriterionDistribution, { outcome_correct: 1 });
});

test('decision eval scenarios invoke, parse, normalize, and score each target', async () => {
  const cases = [
    {
      target: 'entry_answer' as const,
      name: 'direct-answer-arithmetic',
      output: '2 + 3 等于 5。',
    },
  ];
  for (const item of cases) {
    const scenario = getDecisionEvalScenarios(item.target).find(({ caseName }) => caseName === item.name);
    assert.ok(scenario);
    const result = await scenario.run(textModel(item.output));
    assert.ok(result.scores.every(({ score }) => score === 1));
    assert.ok(result.scores.every(({ statement }) => statement.trim()));
    assert.ok(result.scores.every(({ evaluator }) => evaluator === 'deterministic'));
    assert.ok(result.verdict);
    assert.ok(result.shape);
  }
});
