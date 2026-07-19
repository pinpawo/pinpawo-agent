import test from 'node:test';
import assert from 'node:assert/strict';
import { getDecisionEvalScenarios } from './decision-eval-scenarios.ts';
import { summarizeDecisionStability } from './decision-stability.ts';
import { measureDecisionPrompt } from './prompt-preview.ts';

function structuredModel(output: Record<string, unknown>) {
  return {
    withStructuredOutput: () => ({ invoke: async () => output }),
  } as never;
}

test('decision eval scenarios cover every canonical prompt distribution', () => {
  assert.deepEqual({
    entry: getDecisionEvalScenarios('entry').length,
    planner: getDecisionEvalScenarios('planner').length,
    capability: getDecisionEvalScenarios('capability').length,
    outcome: getDecisionEvalScenarios('outcome').length,
  }, { entry: 5, planner: 5, capability: 4, outcome: 3 });
});

test('decision eval scenarios render complete production messages', () => {
  const inputRoots = {
    entry: 'entry_decision_context',
    planner: 'capability_planning_input',
    capability: 'capability_decision_input',
    outcome: 'delegation_outcome_input',
  } as const;
  for (const scenario of getDecisionEvalScenarios()) {
    const prompt = scenario.render();
    assert.match(prompt.system, /pet-agent orchestrator/);
    assert.match(prompt.input, new RegExp(`<${inputRoots[scenario.target]}(?:\\s[^>]*)?>`));
    assert.doesNotMatch(
      `${prompt.system}\n${prompt.input}`,
      /\{(?:config|sharedPrefix|outputInstruction|\w+Block)\}/,
    );
    const metrics = measureDecisionPrompt(prompt);
    assert.ok(metrics.totalChars >= prompt.system.length + prompt.input.length + 1);
    if (scenario.target === 'entry') {
      assert.ok(prompt.conversationMessages?.length);
      assert.equal(prompt.conversationMessages?.at(-1)?._getType(), 'human');
    }
    assert.ok(metrics.approximateTokens > 0);
    assert.ok(metrics.sharedPrefixPercent > 0);
  }
});

test('decision stability summary separates schema and invocation failures', () => {
  const summary = summarizeDecisionStability([
    {
      target: 'outcome', caseId: 'case-1', repeat: 1, ok: true, durationMs: 10,
      verdict: 'goal_done', outputShape: 'gapNote=0', outputFingerprint: 'a', failedScores: [], failureKind: null, error: null,
    },
    {
      target: 'outcome', caseId: 'case-1', repeat: 2, ok: false, durationMs: 20,
      verdict: 'task_done', outputShape: 'gapNote=1', outputFingerprint: 'b', failedScores: ['outcome_correct'], failureKind: null, error: null,
    },
    {
      target: 'outcome', caseId: 'case-1', repeat: 3, ok: false, durationMs: 30,
      verdict: null, outputShape: null, outputFingerprint: null, failedScores: [], failureKind: 'schema', error: 'invalid output',
    },
  ])[0];
  assert.equal(summary.passed, 1);
  assert.equal(summary.schemaFailures, 1);
  assert.equal(summary.invokeFailures, 0);
  assert.equal(summary.outputVariants, 2);
  assert.equal(summary.meanDurationMs, 20);
  assert.deepEqual(summary.verdictDistribution, { goal_done: 1, task_done: 1, error: 1 });
  assert.deepEqual(summary.outputShapeDistribution, { 'gapNote=0': 1, 'gapNote=1': 1, error: 1 });
  assert.deepEqual(summary.failedScoreDistribution, { outcome_correct: 1 });
});

test('decision eval scenarios invoke, parse, normalize, and score each target', async () => {
  const cases = [
    {
      target: 'entry' as const,
      name: 'answer-from-existing-context',
      output: { action: 'answer', task: null, context_summary: null },
    },
    {
      target: 'planner' as const,
      name: 'boundary-cancels-obsolete-task',
      output: { result: 'answer', remaining_plan: [], next_task: null },
    },
    {
      target: 'capability' as const,
      name: 'file-read-falls-back-to-general',
      output: { lane: 'general' },
    },
    {
      target: 'outcome' as const,
      name: 'goal-clearly-complete',
      output: { outcome: 'goal_done', gap_note: null },
    },
  ];
  for (const item of cases) {
    const scenario = getDecisionEvalScenarios(item.target).find(({ caseName }) => caseName === item.name);
    assert.ok(scenario);
    const result = await scenario.run(structuredModel(item.output));
    assert.ok(result.scores.every(({ score }) => score === 1));
    assert.ok(result.verdict);
    assert.ok(result.shape);
  }
});
