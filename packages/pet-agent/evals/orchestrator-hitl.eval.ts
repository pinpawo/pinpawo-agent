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
import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  buildOrchestratorTurnInput,
  createOrchestratorGraph,
} from '../src/index';
import type { AgentActor, AgentModels } from '../src/types/agent';
import type { RouteDecision } from '../src/agent/orchestrator/schemas';

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
      expected_initial_action_name: 'continue_execution_window',
      expected_allowed_decisions: ['approve', 'reject', 'respond'],
      reason: 'Iteration limit uses the same human review interrupt shape, independent of decision schema.',
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

function buildDeterministicModels(decisions: RouteDecision[]): AgentModels {
  let index = 0;
  const routeModel = {
    withStructuredOutput: () => ({
      invoke: async () => {
        const decision = decisions[index] ?? decisions.at(-1) ?? {
          action: 'finish',
          answer: 'done',
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

function readActionRequests(payload: Record<string, unknown> | null): Record<string, unknown>[] {
  return payload && Array.isArray(payload.actionRequests)
    ? payload.actionRequests.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object'),
    )
    : [];
}

function readAllowedDecisions(payload: Record<string, unknown> | null): string[] {
  const configs = payload && Array.isArray(payload.reviewConfigs) ? payload.reviewConfigs : [];
  const first = configs[0];
  if (!first || typeof first !== 'object') return [];
  const allowed = (first as Record<string, unknown>).allowedDecisions;
  return Array.isArray(allowed)
    ? allowed.filter((item): item is string => typeof item === 'string')
    : [];
}

function routeModeFromResult(result: Record<string, unknown>): string {
  const pending = result.pendingDelegation && typeof result.pendingDelegation === 'object'
    ? result.pendingDelegation as Record<string, unknown>
    : null;
  const lane = pending?.lane;
  if (lane === 'general') return 'general';
  if (typeof lane === 'string' && lane.startsWith('capability:')) return 'capability';
  return 'finish';
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
  const turnInput = buildOrchestratorTurnInput([
    new HumanMessage(String(inputs.user_message ?? '')),
  ]);
  if (typeof inputs.iteration_count === 'number') {
    turnInput.iterationCount = inputs.iteration_count;
  }

  const configurable = {
    thread_id: threadId,
    actor: testActor,
    tools: mockTools,
    capabilities: [],
    maxIterations: typeof inputs.max_iterations === 'number' ? inputs.max_iterations : 5,
  };

  const initialResult = await graph.invoke(turnInput, { configurable }) as Record<string, unknown>;
  const initialPayload = readInterruptPayload(initialResult);
  let afterResume: Record<string, unknown> | null = null;

  if (inputs.resume !== undefined) {
    afterResume = await graph.invoke(
      new Command({ resume: inputs.resume }),
      {
        configurable,
        interruptBefore: ['general', 'capability'],
      },
    ) as Record<string, unknown>;
  }

  const actionRequests = readActionRequests(initialPayload);
  return {
    initial_interrupted: Boolean(initialPayload),
    initial_kind: initialPayload?.kind ?? null,
    initial_action_names: actionRequests.flatMap((action) =>
      typeof action.name === 'string' ? [action.name] : [],
    ),
    allowed_decisions: readAllowedDecisions(initialPayload),
    after_resume_mode: afterResume ? routeModeFromResult(afterResume) : null,
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

async function main() {
  const client = new Client();
  await recreateDataset(client);
  console.log(`Running orchestrator HITL evaluation against "${DATASET_NAME}"...`);
  const results = await evaluate(target, {
    data: DATASET_NAME,
    experimentPrefix: 'orchestrator-hitl',
    evaluators: [
      booleanCorrectness('initial_interrupted', 'expected_initial_interrupted', 'initial_interrupted_correct'),
      arrayIncludesCorrectness('initial_action_names', 'expected_initial_action_name', 'initial_action_name_correct'),
      arrayIncludesCorrectness('allowed_decisions', 'expected_allowed_decisions', 'allowed_decisions_correct'),
      equalsCorrectness('after_resume_mode', 'expected_after_resume_mode', 'after_resume_mode_correct'),
      includesCorrectness('after_resume_task', 'expected_after_resume_task_includes', 'after_resume_task_correct'),
      includesCorrectness('reply', 'expected_reply_includes', 'reply_correct'),
    ],
  });

  const rows = results.results;

  const keys = [
    'initial_interrupted_correct',
    'initial_action_name_correct',
    'allowed_decisions_correct',
    'after_resume_mode_correct',
    'after_resume_task_correct',
    'reply_correct',
  ];
  const summarizeScore = (key: string) => {
    const scores = rows.flatMap((row) =>
      row.evaluationResults.results.filter((item) => item.key === key),
    );
    const passed = scores.filter((item) => item.score === 1).length;
    return { passed, total: scores.length, failed: scores.length - passed };
  };

  console.log('\n=== HITL evaluation complete ===');
  for (const key of keys) {
    const score = summarizeScore(key);
    console.log(`${key}: ${score.passed}/${score.total} passed, ${score.failed} failed.`);
  }
  for (const row of rows) {
    const failedScores = row.evaluationResults.results.filter((item) =>
      keys.includes(item.key) && item.score !== 1,
    );
    if (failedScores.length === 0) continue;
    const name = row.example.metadata?.name ?? row.example.id;
    console.log(`  - ${name}: ${failedScores.map((item) => item.comment).join(' | ')}`);
  }
  console.log('View results in LangSmith dashboard.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
