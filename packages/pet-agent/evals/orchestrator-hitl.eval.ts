// @ts-nocheck — eval script, types from langsmith barrel are incomplete
/**
 * LangSmith evaluation: orchestrator HITL behavior.
 *
 * This uses a deterministic route model so the eval focuses on LangGraph HITL
 * mechanics: interrupt payload shape and structured resume decisions.
 *
 * Run:
 *   npm run eval:hitl -w @pinpawo/pet-agent
 */
import { evaluate } from 'langsmith/evaluation';
import { Client } from 'langsmith';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  buildOrchestratorTurnInput,
  createOrchestratorGraph,
} from '../src/index';
import type { AgentActor, AgentModels } from '../src/types/agent';
import type { AgentCapability } from '../src/types/capability';
import type { OrchestrationDecision as RouteDecision } from '../src/agent/orchestrator/schemas';
import { defineToolkit } from '../src/types/toolkit';

const DATASET_NAME = 'orchestrator-hitl';

// HITL eval after the schema-flatten + dead-hint cleanup. Orchestrator-side
// pre-flight review (LLM-driven human_review, continuation-hint gate) has
// been removed. The only HITL path the orchestrator still owns is the
// iteration-limit interrupt, raised inline from runOrchestrationDecision.
// Tool-level review (e.g. local-agent shell confirmation) lives outside this
// package and is exercised in local-agent's own tests.

const examples = [
  {
    name: 'iteration-limit-interrupt',
    inputs: {
      user_message: '继续处理这个长任务',
      route_decisions: [],
      iteration_count: 1,
      max_iterations: 1,
    },
    outputs: {
      expected_initial_interrupted: true,
      expected_initial_kind: 'review',
      expected_review_option_decisions: ['approve', 'reject', 'respond'],
      reason: 'Iteration limit uses the canonical human review interrupt shape without pretending to be a tool action.',
    },
  },
  {
    name: 'iteration-limit-approve-resumes-delegation',
    inputs: {
      user_message: '继续处理这个长任务',
      route_decisions: [
        { action: 'delegate_general', task: '继续整理剩余的日志文件', context_summary: '用户已批准继续执行长任务。' },
      ],
      iteration_count: 1,
      max_iterations: 1,
      resume: { selectedOptionId: 'approve' },
    },
    outputs: {
      expected_initial_interrupted: true,
      expected_initial_kind: 'review',
      expected_after_resume_mode: 'general',
      expected_after_resume_task_includes: '日志',
      reason: 'Approve must reset the iteration count and let the orchestrator keep delegating the same turn.',
    },
  },
  {
    name: 'iteration-limit-approve-resumes-in-progress-capability-lane',
    inputs: {
      user_message: '继续',
      previous_user_message: '帮我调查 pet-app 仓库中 local-agent 的 capability 注册链路，列出关键文件和证据。',
      progress_lane: 'capability:explore',
      progress_task: '调查 pet-app 仓库中 local-agent 的 capability 注册链路，列出关键文件和证据。',
      progress_result: '已定位到部分 registry 文件，但还没有完成完整调用链路调查。',
      progress_completion_reason: 'limit_reached',
      capability_pack: 'explore',
      route_decisions: [
        {
          action: 'delegate_capability.explore',
          task: '继续调查 pet-app 仓库中 local-agent 的 capability 注册链路。',
          context_summary: '上一轮 explore lane 仍处于 progress，用户 resume 后继续同一 capability。',
        },
      ],
      iteration_count: 1,
      max_iterations: 1,
      resume: { selectedOptionId: 'approve' },
    },
    outputs: {
      expected_initial_interrupted: true,
      expected_initial_kind: 'review',
      expected_after_resume_mode: 'capability',
      expected_after_resume_lane: 'capability:explore',
      expected_after_resume_task_includes: '继续调查',
      reason: 'Approve after an orchestrator iteration-limit interrupt should still let the model continue the prior in-progress capability lane.',
    },
  },
  {
    name: 'iteration-limit-respond-injects-guidance',
    inputs: {
      user_message: '继续处理这个长任务',
      route_decisions: [
        { action: 'delegate_general', task: '只处理 src 目录的文件，其余跳过', context_summary: '用户补充了新的处理方向。' },
      ],
      iteration_count: 1,
      max_iterations: 1,
      resume: { selectedOptionId: 'respond', input: { message: '只处理 src 目录，其他跳过。' } },
    },
    outputs: {
      expected_initial_interrupted: true,
      expected_initial_kind: 'review',
      expected_after_resume_mode: 'general',
      expected_after_resume_task_includes: 'src',
      reason: 'Respond must inject the user guidance as a human message and continue with a fresh decision.',
    },
  },
  {
    name: 'iteration-limit-reject-stops',
    inputs: {
      user_message: '继续处理这个长任务',
      route_decisions: [],
      iteration_count: 1,
      max_iterations: 1,
      resume: { selectedOptionId: 'reject' },
    },
    outputs: {
      expected_initial_interrupted: true,
      expected_initial_kind: 'review',
      expected_after_resume_mode: 'answer',
      expected_reply_includes: '已停止',
      reason: 'Reject must stop the loop with a user-facing stop message and no pending delegation.',
    },
  },
];

const testActor: AgentActor = {
  petId: 'eval-pet',
  userId: 'eval-user',
  name: '小白',
  personality: '友好、乐于助人的宠物助手',
  stage: 'adult',
  species: 'cat',
};

const mockTools = [
  tool(async ({ path }) => `[mock] listed ${path}`, {
    name: 'list_dir',
    description: '列出目录内容，不修改文件。',
    schema: z.object({ path: z.string() }),
  }),
  tool(async ({ command }) => `[mock] command ${command}`, {
    name: 'run_shell',
    description: '执行 shell 命令。高风险命令执行前需要人工审批。',
    schema: z.object({ command: z.string() }),
  }),
];

// getInvokeOptions only reads `toolkits`; a bare `tools` key is ignored and
// delegate_general would be forced to answer without any general tools.
const mockToolkit = defineToolkit({
  name: 'eval_general',
  description: 'Mock general tools for HITL evaluation.',
  tools: mockTools,
});

const mockCapabilities: AgentCapability[] = [
  {
    name: 'explore',
    description: '通用探索、调查、资料检索和代码库理解 capability。适合大量阅读、搜索、检查上下文、梳理证据、先探索再决定下一步的任务。',
    createRuntime: () => ({
      instructions: ['负责只读探索、代码库理解、资料检索和证据汇总。'],
      tools: [],
    }),
  },
];

function resolveCapabilityList(pack: unknown): AgentCapability[] {
  if (pack === 'explore') return mockCapabilities.filter((capability) => capability.name === 'explore');
  return [];
}

function buildDeterministicModels(decisions: RouteDecision[]): AgentModels {
  let index = 0;
  const routeModel = {
    // The dedicated answer node calls model.invoke() directly when a decision
    // resolves to `answer`; return a deterministic reply for those cases.
    invoke: async () => new AIMessage('done'),
    withStructuredOutput: () => ({
      invoke: async () => {
        const decision = decisions[index] ?? decisions.at(-1) ?? {
          action: 'answer',
        };
        index += 1;
        return decision;
      },
    }),
  } as unknown as AgentModels['act'];
  return {
    act: routeModel,
    observe: routeModel,
  };
}

async function recreateDataset(client: Client) {
  try {
    const existing = await client.readDataset({ datasetName: DATASET_NAME });
    if (existing?.id) {
      await client.deleteDataset({ datasetId: existing.id });
    }
  } catch {
    // dataset does not exist
  }

  const dataset = await client.createDataset(DATASET_NAME, {
    description: 'Evaluates orchestrator HITL interrupt payloads and structured resume decisions.',
  });
  for (const example of examples) {
    await client.createExample({
      dataset_id: dataset.id,
      inputs: example.inputs,
      outputs: example.outputs,
      metadata: { name: example.name },
    });
  }
}

function readInterruptPayload(result: Record<string, unknown>): Record<string, unknown> | null {
  const interrupts = Array.isArray(result.__interrupt__) ? result.__interrupt__ : [];
  const first = interrupts[0];
  return first && typeof first === 'object' && first.value && typeof first.value === 'object'
    ? first.value as Record<string, unknown>
    : null;
}

function readReviewOptionDecisions(payload: Record<string, unknown> | null): string[] {
  const review = payload?.review && typeof payload.review === 'object'
    ? payload.review as Record<string, unknown>
    : null;
  const options = Array.isArray(review?.options) ? review.options : [];
  if (options.length > 0) {
    return options.flatMap((option) => {
      if (!option || typeof option !== 'object') return [];
      const decision = (option as Record<string, unknown>).decision;
      if (!decision || typeof decision !== 'object') return [];
      const type = (decision as Record<string, unknown>).type;
      return typeof type === 'string' ? [type] : [];
    });
  }

  return [];
}

function routeModeFromResult(result: Record<string, unknown>): string {
  const pending = result.pendingDelegation && typeof result.pendingDelegation === 'object'
    ? result.pendingDelegation as Record<string, unknown>
    : null;
  const lane = pending?.lane;
  if (lane === 'general') return 'general';
  if (typeof lane === 'string' && lane.startsWith('capability:')) return 'capability';
  return 'answer';
}

function pendingLaneFromResult(result: Record<string, unknown>): string | null {
  const pending = result.pendingDelegation && typeof result.pendingDelegation === 'object'
    ? result.pendingDelegation as Record<string, unknown>
    : null;
  return typeof pending?.lane === 'string' ? pending.lane : null;
}

function pendingTaskFromResult(result: Record<string, unknown>): string | null {
  const pending = result.pendingDelegation && typeof result.pendingDelegation === 'object'
    ? result.pendingDelegation as Record<string, unknown>
    : null;
  return typeof pending?.task === 'string' ? pending.task : null;
}

function replyFromResult(result: Record<string, unknown>): string {
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const last = messages.at(-1);
  return last && typeof last === 'object' && typeof last.content === 'string'
    ? last.content
    : '';
}

async function target(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const decisions = Array.isArray(inputs.route_decisions)
    ? inputs.route_decisions as RouteDecision[]
    : [];
  const checkpointer = new MemorySaver();
  const graph = createOrchestratorGraph({
    models: buildDeterministicModels(decisions),
    actor: testActor,
    checkpoint: checkpointer,
  });
  const threadId = `hitl-eval-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const progressLane = typeof inputs.progress_lane === 'string' && inputs.progress_lane.trim()
    ? inputs.progress_lane.trim()
    : null;
  const turnInput = buildOrchestratorTurnInput(progressLane
    ? [
        new HumanMessage(String(inputs.previous_user_message ?? inputs.user_message ?? '')),
        new AIMessage({
          content: String(inputs.progress_result ?? ''),
          additional_kwargs: {
            pinpawo: {
              lane: progressLane,
              turnId: 'previous-turn',
              announce: 'progress',
              delegationId: 'previous-progress-1',
              task: String(inputs.progress_task ?? inputs.previous_user_message ?? inputs.user_message ?? ''),
              ...(typeof inputs.progress_completion_reason === 'string'
                ? { completionReason: inputs.progress_completion_reason }
                : {}),
            },
          },
        }),
        new HumanMessage(String(inputs.user_message ?? '')),
      ]
    : [
        new HumanMessage(String(inputs.user_message ?? '')),
      ]);
  if (typeof inputs.iteration_count === 'number') {
    turnInput.iterationCount = inputs.iteration_count;
  }

  const configurable = {
    thread_id: threadId,
    actor: testActor,
    toolkits: [mockToolkit],
    capabilities: resolveCapabilityList(inputs.capability_pack),
    maxIterations: typeof inputs.max_iterations === 'number' ? inputs.max_iterations : 5,
  };

  const initialResult = await graph.invoke(turnInput, { configurable }) as Record<string, unknown>;
  const initialPayload = readInterruptPayload(initialResult);
  let afterResume: Record<string, unknown> | null = null;

  if (inputs.resume !== undefined) {
    // The review id embeds the random turnId, so the dataset stays declarative
    // (selectedOptionId only) and the target injects the live reviewId.
    const resumeRecord = inputs.resume && typeof inputs.resume === 'object'
      ? inputs.resume as Record<string, unknown>
      : {};
    const resume = {
      reviewId: (initialPayload?.review as Record<string, unknown> | undefined)?.id,
      ...resumeRecord,
    };
    afterResume = await graph.invoke(
      new Command({ resume }),
      {
        configurable,
        interruptBefore: ['general', 'capability'],
      },
    ) as Record<string, unknown>;
  }

  return {
    initial_interrupted: Boolean(initialPayload),
    initial_kind: initialPayload?.kind ?? null,
    review_option_decisions: readReviewOptionDecisions(initialPayload),
    after_resume_mode: afterResume ? routeModeFromResult(afterResume) : null,
    after_resume_lane: afterResume ? pendingLaneFromResult(afterResume) : null,
    after_resume_task: afterResume ? pendingTaskFromResult(afterResume) : null,
    reply: afterResume ? replyFromResult(afterResume) : '',
  };
}

function booleanCorrectness(field: string, expectedField: string, key: string) {
  return ({ outputs, referenceOutputs }) => {
    const expected = referenceOutputs?.[expectedField];
    if (typeof expected !== 'boolean') return { key, score: 1 };
    const actual = outputs?.[field];
    return {
      key,
      score: actual === expected ? 1 : 0,
      comment: actual === expected ? `Correct: ${actual}` : `Expected ${expected}, got ${actual}`,
    };
  };
}

function equalsCorrectness(field: string, expectedField: string, key: string) {
  return ({ outputs, referenceOutputs }) => {
    const expected = referenceOutputs?.[expectedField];
    if (typeof expected !== 'string') return { key, score: 1 };
    const actual = outputs?.[field];
    return {
      key,
      score: actual === expected ? 1 : 0,
      comment: actual === expected ? `Correct: ${actual}` : `Expected ${expected}, got ${actual}`,
    };
  };
}

function includesCorrectness(field: string, expectedField: string, key: string) {
  return ({ outputs, referenceOutputs }) => {
    const expected = referenceOutputs?.[expectedField];
    if (typeof expected !== 'string') return { key, score: 1 };
    const actual = typeof outputs?.[field] === 'string' ? outputs[field] : '';
    return {
      key,
      score: actual.includes(expected) ? 1 : 0,
      comment: actual.includes(expected) ? `Includes ${expected}` : `Expected ${field} to include ${expected}, got ${actual}`,
    };
  };
}

function arrayIncludesCorrectness(field: string, expectedField: string, key: string) {
  return ({ outputs, referenceOutputs }) => {
    const rawExpected = referenceOutputs?.[expectedField];
    const expected = typeof rawExpected === 'string'
      ? [rawExpected]
      : Array.isArray(rawExpected)
        ? rawExpected
        : null;
    if (!expected) return { key, score: 1 };
    const actual = Array.isArray(outputs?.[field]) ? outputs[field] : [];
    const missing = expected.filter((item) => !actual.includes(item));
    return {
      key,
      score: missing.length === 0 ? 1 : 0,
      comment: missing.length === 0
        ? `Contains ${expected.join(', ')}`
        : `Missing ${missing.join(', ')} from ${JSON.stringify(actual)}`,
    };
  };
}

const hitlEvaluators = [
  booleanCorrectness('initial_interrupted', 'expected_initial_interrupted', 'initial_interrupted_correct'),
  equalsCorrectness('initial_kind', 'expected_initial_kind', 'initial_kind_correct'),
  arrayIncludesCorrectness(
    'review_option_decisions',
    'expected_review_option_decisions',
    'review_option_decisions_correct',
  ),
  equalsCorrectness('after_resume_mode', 'expected_after_resume_mode', 'after_resume_mode_correct'),
  equalsCorrectness('after_resume_lane', 'expected_after_resume_lane', 'after_resume_lane_correct'),
  includesCorrectness('after_resume_task', 'expected_after_resume_task_includes', 'after_resume_task_correct'),
  includesCorrectness('reply', 'expected_reply_includes', 'reply_correct'),
];

const hitlScoreKeys = [
  'initial_interrupted_correct',
  'initial_kind_correct',
  'review_option_decisions_correct',
  'after_resume_mode_correct',
  'after_resume_lane_correct',
  'after_resume_task_correct',
  'reply_correct',
];

async function runLocal() {
  console.log(`Running local orchestrator HITL evaluation against ${examples.length} example(s)...`);
  const rows = [];
  for (const example of examples) {
    const outputs = await target(example.inputs);
    const scores = hitlEvaluators.map((evaluator) =>
      evaluator({
        outputs,
        referenceOutputs: example.outputs,
      }),
    );
    rows.push({ example, outputs, scores });
  }

  console.log('\n=== Local HITL evaluation complete ===');
  for (const key of hitlScoreKeys) {
    const scores = rows.flatMap((row) => row.scores.filter((item) => item.key === key));
    const passed = scores.filter((item) => item.score === 1).length;
    console.log(`${key}: ${passed}/${scores.length} passed, ${scores.length - passed} failed.`);
  }
  for (const row of rows) {
    const failedScores = row.scores.filter((item) => hitlScoreKeys.includes(item.key) && item.score !== 1);
    if (failedScores.length === 0) continue;
    console.log(`  - ${row.example.name}: ${failedScores.map((item) => item.comment).join(' | ')}`);
    console.log(`    outputs: ${JSON.stringify(row.outputs)}`);
  }
}

async function main() {
  if (process.env.SKIP_DATASET_SYNC === '1') {
    console.log(`Using existing LangSmith dataset "${DATASET_NAME}" (SKIP_DATASET_SYNC=1).`);
  } else {
    const client = new Client();
    await recreateDataset(client);
  }
  console.log(`Running orchestrator HITL evaluation against "${DATASET_NAME}"...`);
  const results = await evaluate(target, {
    data: DATASET_NAME,
    experimentPrefix: 'orchestrator-hitl',
    evaluators: hitlEvaluators,
  });

  const rows = results.results;

  const summarizeScore = (key: string) => {
    const scores = rows.flatMap((row) =>
      row.evaluationResults.results.filter((item) => item.key === key),
    );
    const passed = scores.filter((item) => item.score === 1).length;
    return { passed, total: scores.length, failed: scores.length - passed };
  };

  console.log('\n=== HITL evaluation complete ===');
  for (const key of hitlScoreKeys) {
    const score = summarizeScore(key);
    console.log(`${key}: ${score.passed}/${score.total} passed, ${score.failed} failed.`);
  }
  for (const row of rows) {
    const failedScores = row.evaluationResults.results.filter((item) =>
      hitlScoreKeys.includes(item.key) && item.score !== 1,
    );
    if (failedScores.length === 0) continue;
    const name = row.example.metadata?.name ?? row.example.id;
    console.log(`  - ${name}: ${failedScores.map((item) => item.comment).join(' | ')}`);
  }
  console.log('View results in LangSmith dashboard.');
}

(process.env.LOCAL_EVAL === '1' ? runLocal() : main()).catch((err) => {
  console.error(err);
  process.exit(1);
});
