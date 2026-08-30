import { AIMessage, AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  buildOrchestratorTurnInput,
  createOrchestratorGraph,
} from '../../src/agent/createAgentRuntime.ts';
import { getAgentMessageLane } from '../../src/agent/messages/index.ts';
import {
  defineInstructionDocument,
  type AgentCapability,
} from '../../src/types/capability.ts';
import { defineToolkit } from '../../src/types/toolkit.ts';
import type { AgentModels } from '../../src/types/agent.ts';
import type { CapabilityPlannerRunner } from '../../src/agent/orchestrator/capabilityPlanner/runner.ts';
import { PLAN_REQUEST_TOOL_NAME } from '../../src/agent/orchestrator/runtime/nodes/entryAnswer.ts';
import { compileAgentRegistry } from '../../src/agent/orchestrator/registry.ts';
import { multiTaskFlowBasicsDataset } from '../datasets/multi-task-flow-basics.ts';
import { readRunDelegationSummaries, routeModeFromResult } from '../orchestratorStateReaders.ts';
import { writeLangfuseEvalResult, type LangfuseEvalScore } from './langfuse-eval-writer.ts';
import { resolveLangfuseConfig } from './langfuse-api.ts';
import { createLangfuseV4Runtime } from './langfuse-v4-runtime.ts';

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
  tools: [{
    tool: tool(async () => 'ok', {
      name: 'eval_noop',
      description: 'No-op tool used only to make the general capability available.',
      schema: z.object({}),
    }),
  }],
});

const capabilities: AgentCapability[] = [
  {
    name: 'explore',
    description: '代码库调查、结构分析、依赖和风险探索。Keywords: 代码库|auth|调查|结构',
    uses: ['multi_task_eval_general'],
    instructions: defineInstructionDocument({
      content: 'Investigate the requested codebase task.',
    }),
  },
  {
    name: 'code_modify',
    description: '代码修改与重构。Keywords: 代码修改|auth|重构|token validation',
    uses: ['multi_task_eval_general'],
    instructions: defineInstructionDocument({
      content: 'Implement the requested code changes.',
    }),
  },
];

const registry = compileAgentRegistry({
  toolkits: [generalToolkit],
  capabilities,
});

function buildRecordingSubagent(responses: string[]) {
  const model = new FakeListChatModel({ responses: ['unused'], sleep: 0 });
  const laneMessageCounts: number[] = [];
  let responseIndex = 0;
  const bindTools = model.bindTools.bind(model);
  model.bindTools = ((tools) => {
    const runnable = bindTools(tools);
    runnable.invoke = async (input) => {
      const messages = Array.isArray(input) ? input : [];
      laneMessageCounts.push(messages.filter((message) => getAgentMessageLane(message as never) !== null).length);
      const response = responses[responseIndex] ?? responses.at(-1) ?? '';
      responseIndex += 1;
      return new AIMessageChunk(response);
    };
    return runnable;
  }) as typeof model.bindTools;
  return { model, laneMessageCounts };
}

function buildScriptedAnswerModel() {
  const model = {
    invoke: async () => new AIMessage(
      'auth 重构已经完成：token validation 已提取，循环依赖已移除，公开接口保持不变，测试通过。',
    ),
    bindTools: () => ({
      invoke: async () => new AIMessage({
        content: '',
        tool_calls: [{
          id: 'multi-task-eval-plan-request',
          name: PLAN_REQUEST_TOOL_NAME,
          args: {},
        }],
      }),
    }),
  } as unknown as AgentModels['act'];
  return { model };
}

function buildScriptedPlannerRunner() {
  let plannerDecisionCount = 0;
  const selectedCapabilityNames: string[] = [];
  const plannedObjectives: string[] = [];
  let secondTaskSawHandoff = false;
  const runner: CapabilityPlannerRunner = {
    async invoke(input) {
      plannerDecisionCount += 1;
      if (plannerDecisionCount === 1) {
        const objective = '调查 auth 模块的结构、依赖和风险';
        plannedObjectives.push(objective);
        selectedCapabilityNames.push('explore');
        return {
          action: 'execute_plan',
          tasks: [{
            capability: 'explore',
            task: objective,
          }, {
            capability: 'code_modify',
            task: '根据调查结论重构 auth 模块',
          }],
        };
      }
      if (plannerDecisionCount > 2) {
        return { action: 'goal_done', tasks: [] };
      }
      secondTaskSawHandoff = /循环依赖|token validation/.test(
        input.messages.map((message) => message.text).join('\n'),
      );
      const objective = '根据调查结论重构 auth 模块，提取 token validation 并移除循环依赖';
      plannedObjectives.push(objective);
      selectedCapabilityNames.push('code_modify');
      return {
        action: 'advance_plan',
        tasks: [{
          capability: 'code_modify',
          task: objective,
        }],
      };
    },
  };
  return {
    runner,
    stats: () => ({
      plannerDecisionCount,
      plannedObjectives,
      selectedCapabilityNames,
      secondTaskSawHandoff,
    }),
  };
}

function taskMatches(actual: string, expectedTerms: string[]) {
  return expectedTerms.every((term) => actual.toLowerCase().includes(term.toLowerCase()));
}

async function runCase(testCase: typeof multiTaskFlowBasicsDataset.cases[number]) {
  const answers = buildScriptedAnswerModel();
  const planner = buildScriptedPlannerRunner();
  const subagent = buildRecordingSubagent(testCase.input.subagentResults);
  const graph = createOrchestratorGraph({
    models: {
      act: answers.model,
      answer: answers.model,
      observe: answers.model,
      subagent: subagent.model,
    },
    actor,
    capabilityPlannerRunner: planner.runner,
  });
  const result = await graph.invoke(
    buildOrchestratorTurnInput([new HumanMessage(testCase.input.userMessage)]),
    {
      configurable: {
        thread_id: `multi-task-flow-${Date.now()}`,
        actor,
        registry,
        maxRunIterations: 10,
        workdir: '/mock/project',
      },
    },
  ) as Record<string, unknown>;
  const summaries = readRunDelegationSummaries(result);
  const tasks = summaries.map((summary) => summary.task);
  const statuses = summaries.map((summary) => summary.status);
  const acceptedResultText = summaries
    .map((summary) => summary.resultPreview ?? '')
    .join('\n');
  const stats = {
    ...planner.stats(),
  };
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const finalText = String((messages.at(-1) as { content?: unknown } | undefined)?.content ?? '');
  const remainingLaneMessageCount = messages.filter((message) => getAgentMessageLane(message as never) !== null).length;
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
      score: stats.plannedObjectives.length === expected.expectedPlannedObjectiveTerms.length
        && stats.plannedObjectives.every((objective, index) =>
          (expected.expectedPlannedObjectiveTerms[index] ?? []).every((term) => objective.includes(term)))
        && stats.plannerDecisionCount === expected.expectedDelegationCount + 1
        && JSON.stringify(stats.selectedCapabilityNames) === JSON.stringify(expected.expectedCapabilityNames)
        && summaries.length === expected.expectedTaskTerms.length ? 1 : 0,
      comment: `plannedObjectives=${JSON.stringify(stats.plannedObjectives)}, plannerDecisions=${stats.plannerDecisionCount}, selected=${JSON.stringify(stats.selectedCapabilityNames)}`,
    },
    {
      key: 'handoff_consumed_by_next_task_correct',
      score: stats.secondTaskSawHandoff ? 1 : 0,
      comment: `secondTaskSawHandoff=${String(stats.secondTaskSawHandoff)}`,
    },
    {
      key: 'lane_isolation_correct',
      score: remainingLaneMessageCount === 0
        && subagent.laneMessageCounts.length === expected.expectedDelegationCount
        && subagent.laneMessageCounts.every((count) => count === 1) ? 1 : 0,
      comment: `subagentInputLaneMessages=${JSON.stringify(subagent.laneMessageCounts)}, remainingLaneMessages=${remainingLaneMessageCount}`,
    },
    {
      key: 'handoff_completion_correct',
      score: statuses.every((status) => status === 'completed') ? 1 : 0,
      comment: `statuses=${statuses.join(',')}`,
    },
    {
      key: 'result_evidence_retained_correct',
      score: expected.expectedResultTerms.every((term) =>
        acceptedResultText.includes(term)) ? 1 : 0,
      comment: `acceptedResultTermsPresent=${String(
        expected.expectedResultTerms.every((term) => acceptedResultText.includes(term)),
      )}`,
    },
    {
      key: 'final_answer_correct',
      score: routeModeFromResult(result) === expected.expectedFinalMode
        && expected.expectedResultTerms.every((term) => finalText.includes(term)) ? 1 : 0,
      comment: `final=${finalText}`,
    },
  ];
  return {
    output: {
      tasks,
      statuses,
      resultPreviews: summaries.map((summary) => summary.resultPreview),
      delegationCount: summaries.length,
      ...stats,
      finalMode: routeModeFromResult(result),
      finalText,
      remainingLaneMessageCount,
      subagentInputLaneMessageCounts: subagent.laneMessageCounts,
    },
    scores,
  };
}

async function main() {
  const config = resolveLangfuseConfig();
  const runtime = createLangfuseV4Runtime(config);
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
        runtime,
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
  await runtime.shutdown();
  console.log(`Cases: ${passed}/${multiTaskFlowBasicsDataset.cases.length} passed`);
  if (passed !== multiTaskFlowBasicsDataset.cases.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
