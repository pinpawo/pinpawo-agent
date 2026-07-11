import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  buildOrchestratorTurnInput,
  createOrchestratorGraph,
} from '../../src/agent/createAgentRuntime.ts';
import { defineToolkit } from '../../src/types/toolkit.ts';
import type { AgentModels } from '../../src/types/agent.ts';
import { multiTaskFlowBasicsDataset } from '../datasets/multi-task-flow-basics.ts';
import { readRunDelegationSummaries, routeModeFromResult } from '../orchestratorStateReaders.ts';
import { writeLangfuseEvalResult, type LangfuseEvalScore } from './langfuse-eval-writer.ts';
import { resolveLangfuseConfig } from './langfuse-api.ts';

const actor = {
  petId: 'eval-pet',
  userId: 'eval-user',
  name: 'multi-task-flow-eval',
  personality: null,
  stage: null,
  species: null,
};

const generalToolkit = defineToolkit({
  name: 'multi_task_eval_general',
  description: 'General capability marker for deterministic multi-task flow evaluation.',
  tools: [tool(async () => 'ok', {
    name: 'eval_noop',
    description: 'No-op tool used only to make the general capability available.',
    schema: z.object({}),
  })],
});

function buildScriptedDecisionModel() {
  let taskDecisionCount = 0;
  let routeDecisionCount = 0;
  let outcomeDecisionCount = 0;
  const searchQueries: string[] = [];
  const model = {
    invoke: async () => new AIMessage(
      'auth 重构已经完成：token validation 已提取，循环依赖已移除，公开接口保持不变，测试通过。',
    ),
    bindTools: () => ({ invoke: async () => new AIMessage('') }),
    withStructuredOutput: () => ({
      invoke: async (messages: unknown[]) => {
        const text = messages.map((message) => String((message as { content?: unknown })?.content ?? '')).join('\n');
        if (/task decision 节点/.test(text)) {
          taskDecisionCount += 1;
          if (taskDecisionCount === 1) {
            const decision = {
              action: 'next_task',
              task: '调查 auth 模块的结构、依赖和风险',
              context_summary: '探索结论将决定后续重构任务。',
              search_keywords: '代码库|auth|调查|结构',
            };
            searchQueries.push(decision.search_keywords);
            return decision;
          }
          if (taskDecisionCount === 2) {
            const decision = {
              action: 'next_task',
              task: '根据调查结论重构 auth 模块，提取 token validation 并移除循环依赖',
              context_summary: '调查已定位循环依赖，按 handoff 结论实施重构。',
              search_keywords: '代码修改|auth|重构|token validation',
            };
            searchQueries.push(decision.search_keywords);
            return decision;
          }
          return { action: 'answer' };
        }
        if (/route decision 节点/.test(text)) {
          routeDecisionCount += 1;
          return { lane: 'general' };
        }
        if (/子任务结果验收节点/.test(text)) {
          outcomeDecisionCount += 1;
          return outcomeDecisionCount === 1
            ? { outcome: 'task_done', gap_note: '调查完成，后续重构任务应根据 handoff 具体化。' }
            : { outcome: 'goal_done', gap_note: null };
        }
        throw new Error('Unexpected decision prompt in multi-task flow eval');
      },
    }),
  } as unknown as AgentModels['act'];
  return {
    model,
    stats: () => ({ taskDecisionCount, routeDecisionCount, outcomeDecisionCount, searchQueries }),
  };
}

function taskMatches(actual: string, expectedTerms: string[]) {
  return expectedTerms.every((term) => actual.toLowerCase().includes(term.toLowerCase()));
}

async function runCase(testCase: typeof multiTaskFlowBasicsDataset.cases[number]) {
  const decisions = buildScriptedDecisionModel();
  const subagent = new FakeListChatModel({ responses: testCase.input.subagentResults, sleep: 0 });
  const graph = createOrchestratorGraph({
    models: {
      act: decisions.model,
      observe: decisions.model,
      subagent,
    },
    actor,
  });
  const result = await graph.invoke(
    buildOrchestratorTurnInput([new HumanMessage(testCase.input.userMessage)]),
    {
      configurable: {
        thread_id: `multi-task-flow-${Date.now()}`,
        actor,
        toolkits: [generalToolkit],
        capabilities: [],
        maxIterations: 10,
        workdir: '/mock/project',
      },
    },
  ) as Record<string, unknown>;
  const summaries = readRunDelegationSummaries(result);
  const tasks = summaries.map((summary) => summary.task);
  const statuses = summaries.map((summary) => summary.status);
  const stats = decisions.stats();
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const finalText = String((messages.at(-1) as { content?: unknown } | undefined)?.content ?? '');
  const expected = testCase.expected;
  const scores: LangfuseEvalScore[] = [
    {
      key: 'task_order_correct',
      score: tasks.length === expected.expectedTaskTerms.length
        && tasks.every((task, index) => taskMatches(task, expected.expectedTaskTerms[index] ?? [])) ? 1 : 0,
      comment: `tasks=${JSON.stringify(tasks)}`,
    },
    {
      key: 'delegation_count_correct',
      score: summaries.length === expected.expectedDelegationCount ? 1 : 0,
      comment: `delegations=${summaries.length}`,
    },
    {
      key: 'per_task_pipeline_correct',
      score: stats.searchQueries.length === expected.expectedSearchQueryTerms.length
        && stats.searchQueries.every((query, index) =>
          (expected.expectedSearchQueryTerms[index] ?? []).every((term) => query.includes(term)))
        && summaries.length === expected.expectedTaskTerms.length ? 1 : 0,
      comment: `searchQueries=${JSON.stringify(stats.searchQueries)}, delegations=${summaries.length}`,
    },
    {
      key: 'handoff_completion_correct',
      score: statuses.every((status) => status === 'completed') ? 1 : 0,
      comment: `statuses=${statuses.join(',')}`,
    },
    {
      key: 'final_answer_correct',
      score: routeModeFromResult(result) === expected.expectedFinalMode
        && expected.expectedResultTerms.every((term) => finalText.includes(term)) ? 1 : 0,
      comment: finalText,
    },
  ];
  return {
    output: {
      tasks,
      statuses,
      delegationCount: summaries.length,
      ...stats,
      finalMode: routeModeFromResult(result),
      finalText,
    },
    scores,
  };
}

async function main() {
  const config = resolveLangfuseConfig();
  const runName = process.env.LANGFUSE_RUN_NAME
    || `multi-task-flow-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`Running ${multiTaskFlowBasicsDataset.name}: ${runName}`);
  let passed = 0;
  for (const testCase of multiTaskFlowBasicsDataset.cases) {
    const started = performance.now();
    try {
      const { output, scores } = await runCase(testCase);
      const ok = scores.every((score) => score.score === 1);
      if (ok) passed += 1;
      await writeLangfuseEvalResult({
        config,
        datasetName: multiTaskFlowBasicsDataset.name,
        runName,
        traceName: 'multi-task-flow-eval',
        testCase,
        output,
        scores,
        durationMs: Math.round(performance.now() - started),
      });
      console.log(`[${ok ? 'PASS' : 'FAIL'}] ${testCase.name}: ${scores.map((score) => `${score.key}=${score.score}`).join(' ')}`);
      if (!ok) console.log(`  output=${JSON.stringify(output)}`);
    } catch (error) {
      console.log(`[ERROR] ${testCase.name}: ${String(error)}`);
    }
  }
  console.log(`Cases: ${passed}/${multiTaskFlowBasicsDataset.cases.length} passed`);
  if (passed !== multiTaskFlowBasicsDataset.cases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
