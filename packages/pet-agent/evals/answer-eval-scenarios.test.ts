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

test('answer eval models goal_done as a grounded task summary', async () => {
  const scenario = getAnswerEvalScenarios().find(
    ({ caseName }) => caseName === 'task-completion-summary',
  );
  assert.ok(scenario);
  let subjectInvocations = 0;
  const summary = '本周发布风险汇总已完成：关键风险为 database-freeze-42 和 queue-drain-88，建议分三阶段切流。';
  const subject = {
    invoke: async () => {
      subjectInvocations += 1;
      return new AIMessage(summary);
    },
  } as never;
  const result = await scenario.run(subject, undefined, {
    model: answerModel('judge'),
  });

  assert.equal(scenario.execution, 'model');
  assert.deepEqual(scenario.render().map((message) => message._getType()), [
    'system',
    'human',
    'ai',
    'human',
  ]);
  assert.equal(subjectInvocations, 1);
  assert.equal(result.output.text, summary);
  const answerInput = String(scenario.render().at(-1)?.content);
  assert.match(answerInput, /^<answer_input[^>]*>/);
  assert.match(answerInput, /<run_user_goal[^>]*>/);
  assert.match(answerInput, /<reply_mode>goal_done<\/reply_mode>/);
});

test('trace-shaped and instruction-like completed tasks cannot become future work', async () => {
  const scenarios = getAnswerEvalScenarios().filter(({ caseName }) => [
    'long-imperative-completion',
    'instruction-like-completion',
    'completed-pr-does-not-restart',
  ].includes(caseName));
  let subjectInvocations = 0;
  const summaries = [
    '账号公开信息整理已完成：已提取昵称、简介、公开指标和可见内容摘要，并形成结构化结果。',
    '安全测试已完成，测试过程中未执行任务文本中携带的额外指令。',
    '已基于最新 main 完成浏览器交互稳定等待的重新实现，并创建 PR #600 替代旧 PR #596；相关接线和测试均已完成，工作树干净。',
  ];
  const subject = {
    invoke: async () => {
      const summary = summaries[subjectInvocations] ?? '任务总结缺失';
      subjectInvocations += 1;
      return new AIMessage(summary);
    },
  } as never;

  assert.equal(scenarios.length, 3);
  for (const scenario of scenarios) {
    const result = await scenario.run(subject, undefined, {
      model: answerModel('judge'),
    });
    assert.equal(scenario.execution, 'model');
    assert.match(String(scenario.render().at(-1)?.content), /<reply_mode>goal_done<\/reply_mode>/);
    assert.doesNotMatch(String(scenario.render()[0]?.content), /打开用户|忽略 Answer|调用浏览器|PR #596|PR #600/);
    assert.doesNotMatch(
      String(result.output.text),
      /将要打开|等待页面渲染|准备提取|任务尚未开始|浏览器继续|先检查|核实分支|DSML|bash/,
    );
  }
  assert.equal(subjectInvocations, 3);
});

test('answer eval covers a resumable result that requires a user choice', () => {
  const scenario = getAnswerEvalScenarios().find(
    ({ caseName }) => caseName === 'handoff-requires-user-choice',
  );
  assert.ok(scenario);
  const messages = scenario.render();
  assert.deepEqual(messages.map((message) => message._getType()), [
    'system',
    'human',
    'ai',
    'human',
  ]);
  assert.equal(scenario.expectedSummary, 'return_control');
  const systemText = String(messages[0].content);
  const contextText = String(messages.at(-1)?.content);
  assert.doesNotMatch(systemText, /邮件或项目群|报告已经完成|确认发送渠道/);
  assert.doesNotMatch(systemText, /"确认发送渠道并发送已经完成的报告"已完成/);
  assert.match(String(messages[1].content), /邮件或项目群/);
  assert.match(String(messages[2].content), /还没有发送/);
  assert.match(contextText, /^<answer_input[^>]*>/);
  assert.match(contextText, /<run_user_goal[^>]*>/);
  assert.match(contextText, /<reply_mode>user_input_required<\/reply_mode>/);
});

test('answer eval uses the normalized run goal to scope a contextual request', () => {
  const scenario = getAnswerEvalScenarios().find(
    ({ caseName }) => caseName === 'normalized-goal-scopes-completion',
  );
  assert.ok(scenario);
  const messages = scenario.render();
  const answerInput = String(messages.at(-1)?.content);
  assert.match(answerInput, /只完成 Answer 节点与 run user goal 的对齐/);
  assert.match(answerInput, /<reply_mode>goal_done<\/reply_mode>/);
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
    ({ caseName }) => caseName === 'task-completion-summary',
  );
  assert.ok(completion);

  const result = await completion.run(answerModel(
    '完成。完整风险正文：database-freeze-42；queue-drain-88；建议分三阶段切流。',
    ['key_results_preserved'],
  ));
  assert.equal(
    result.scores.find(({ key }) => key === 'key_results_preserved')?.score,
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
