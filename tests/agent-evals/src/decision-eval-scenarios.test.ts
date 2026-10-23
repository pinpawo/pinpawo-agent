import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import { getDecisionEvalScenarios } from './decision-eval-scenarios.ts';
import { MAX_PLAN_REQUEST_GOAL_CHARS } from '../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/entryAnswer.ts';
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
  }, { entryAnswer: 10 });
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


test('Entry eval reports continue distinctly and requires an unfinished plan', async () => {
  const response = new AIMessage({ content: '', tool_calls: [{ name: 'continue', id: 'continue', args: {} }] });
  const model = { bindTools: () => ({ invoke: async () => response }) } as never;
  for (const name of ['reference-resolution-adds-no-scope', 'saved-unfinished-plan-continues', 'finished-plan-requires-new-planning']) {
    const scenario = getDecisionEvalScenarios().find(scenario => scenario.caseName === name)!;
    const result = await scenario.run(model);
    assert.equal(result.output.route, 'continue');
    assert.equal(result.scores.every(score => score.score === 1), name === 'saved-unfinished-plan-continues');
  }
});

function routedModel(text: string, name: string, args: Record<string, unknown>) {
  const response = new AIMessage({ content: text, tool_calls: [{ name, id: name, args }] });
  return { bindTools: () => ({ invoke: async () => response }) } as never;
}

function shapeScore(result: { scores: Array<{ key: string; score: number }> }, key: string) {
  return result.scores.find((score) => score.key === key)?.score;
}

test('Entry shape checks use the production routing schemas', async () => {
  const scenario = (name: string) => getDecisionEvalScenarios().find(({ caseName }) => caseName === name)!;
  const plan = scenario('repository-task-enters-supervisor');
  const resume = scenario('saved-unfinished-plan-continues');
  const tooLong = 'x'.repeat(MAX_PLAN_REQUEST_GOAL_CHARS + 1);
  assert.equal(shapeScore(await plan.run(routedModel('我先交给执行方修复 TypeScript 错误。', 'plan_request', { goal: '修复 TypeScript 错误并运行测试。' })), 'plan_request_shape'), 1);
  assert.equal(shapeScore(await plan.run(routedModel('', 'plan_request', { goal: tooLong })), 'plan_request_shape'), 0);
  assert.equal(shapeScore(await plan.run(routedModel('', 'plan_request', { goal: '修复', extra: true })), 'plan_request_shape'), 0);
  assert.equal(shapeScore(await plan.run(routedModel('', 'plan_request', {})), 'plan_request_shape'), 0);
  assert.equal(shapeScore(await resume.run(routedModel('接着安排交通。', 'continue', { goal: '安排周末的杭州旅行，含往返交通。' })), 'continue_shape'), 1);
  assert.equal(shapeScore(await resume.run(routedModel('', 'continue', { goal: tooLong })), 'continue_shape'), 0);
  assert.equal(shapeScore(await resume.run(routedModel('', 'continue', { scope: 'all' })), 'continue_shape'), 0);
});

test('Entry eval asks the judge about the handoff note and output language', async () => {
  const asked: string[][] = [];
  const judge = {
    model: {
      withStructuredOutput: () => ({
        invoke: async (messages: Array<{ content: unknown }>) => {
          const ids = (JSON.parse(String(messages[1].content)).acceptanceCriteria as Array<{ id: string }>).map(({ id }) => id);
          asked.push(ids);
          return { criteria: Object.fromEntries(ids.map((id) => [id, { met: id !== 'handoff_note_announces_only', reason: 'stub' }])), summary: 'stub' };
        },
      }),
    },
  } as never;
  const scenario = getDecisionEvalScenarios().find(({ caseName }) => caseName === 'explicit-output-language-routes')!;
  const result = await scenario.run(routedModel('All TypeScript errors are fixed and tests pass.', 'plan_request', { goal: 'Fix the TypeScript errors and run the tests.' }), undefined, undefined, judge);
  assert.deepEqual(asked, [['handoff_note_announces_only', 'user_visible_language']]);
  assert.equal(shapeScore(result, 'plan_request_shape'), 1);
  assert.equal(shapeScore(result, 'handoff_note_announces_only'), 0);
  assert.equal(result.verdict, 'invalid_route');
  const statement = result.scores.find(({ key }) => key === 'user_visible_language')?.statement;
  assert.match(statement ?? '', /English/);
});
