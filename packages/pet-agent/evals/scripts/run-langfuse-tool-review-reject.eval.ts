import { randomUUID } from 'node:crypto';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command, MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';
import type { AgentActor, AgentModels } from '../../src/types/agent';
import { createOrchestratorGraph, buildOrchestratorRunInput } from '../../src/agent/createAgentRuntime';
import { buildReviewSpec } from '../../src/agent/orchestrator/review/reviewSpec';
import {
  getMessageHandoffSource,
  mainConversationMessages,
} from '../../src/agent/orchestrator/messageLanes';
import {
  defineCapability,
  defineInstructionDocument,
} from '../../src/types/capability';
import { defineToolkit } from '../../src/types/toolkit';
import {
  toolReviewRejectRuntimeDataset,
  type ToolReviewRejectRuntimeExpected,
  type ToolReviewRejectRuntimeInput,
} from '../datasets/tool-review-reject-runtime.ts';
import {
  langfuseFetch,
  resolveLangfuseConfig,
} from './langfuse-api.ts';

type ScoreResult = {
  key: string;
  score: number;
  comment?: string;
};

type EvalOutput = {
  interrupted: boolean;
  firstReviewId: string | null;
  finalInterrupt: boolean;
  toolRunCount: number;
  rejectedToolResultSeenBySubagent: boolean;
  handoffPresent: boolean;
  handoffText: string;
  authorizationCount: number;
  finalReply: string;
};

type EvalRow = {
  id: string;
  name: string;
  suite: string;
  tags: string[];
  ok: boolean;
  durationMs: number;
  scores: ScoreResult[];
  output: Partial<EvalOutput>;
  error?: string;
};

const testActor: AgentActor = {
  petId: 'eval-pet',
  userId: 'eval-user',
  name: '小白',
  personality: '友好、乐于助人的宠物助手',
  stage: 'adult',
  species: 'cat',
};

const scoreKeys = [
  'interrupted_correct',
  'final_interrupt_correct',
  'tool_run_count_correct',
  'rejected_tool_result_seen_by_subagent',
  'handoff_correct',
  'authorization_count_correct',
  'final_announce_correct',
];

function splitList(value: string | undefined): string[] {
  return value?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
}

function selectedCases() {
  const requested = new Set(splitList(process.env.EVAL_CASES));
  if (requested.size === 0) return toolReviewRejectRuntimeDataset.cases;
  return toolReviewRejectRuntimeDataset.cases.filter((testCase) =>
    requested.has(testCase.id) || requested.has(testCase.name),
  );
}

function compactError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 800);
  }
  return String(error).slice(0, 800);
}

function createRouteModel(): AgentModels['act'] {
  let decisionCount = 0;
  return {
    invoke: async () => new AIMessage('任务已完成。'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        decisionCount += 1;
        if (decisionCount === 1) {
          return { action: 'needs_plan' };
        }
        return { outcome: 'goal_done', gap_note: null };
      },
    }),
  } as unknown as AgentModels['act'];
}

class ToolReviewRejectSubagentModel extends BaseChatModel {
  private invocationCount = 0;

  constructor(
    private readonly reviewedTool: string,
    private readonly firstToolCall: ToolReviewRejectRuntimeInput['firstToolCall'],
    private readonly finalResponse: string,
  ) {
    super({});
  }

  _llmType() {
    return 'tool-review-reject-eval';
  }

  bindTools() {
    return this;
  }

  async _generate() {
    this.invocationCount += 1;
    const message = this.invocationCount === 1
      ? new AIMessage({
          content: '',
          tool_calls: [{
            id: this.firstToolCall.id,
            name: this.reviewedTool,
            args: this.firstToolCall.args,
          }],
        })
      : new AIMessage(this.finalResponse);
    return {
      generations: [{
        text: typeof message.content === 'string' ? message.content : '',
        message,
      }],
    };
  }
}

function createSubagentInputRecorder() {
  const subagentInputs: BaseMessage[][] = [];
  return {
    subagentInputs,
    callbacks: [{
      handleChatModelStart: (_llm: unknown, messages: BaseMessage[][]) => {
        subagentInputs.push(...messages);
      },
    }],
  };
}

function readInterruptPayload(value: unknown): {
  kind?: unknown;
  reviews?: Array<{ review?: { id?: string } }>;
} | null {
  return value && typeof value === 'object'
    ? value as { kind?: unknown; reviews?: Array<{ review?: { id?: string } }> }
    : null;
}

function readLastText(messages: BaseMessage[]): string {
  const content = messages.at(-1)?.content;
  return typeof content === 'string' ? content : '';
}

function findHandoffText(messages: BaseMessage[]): string {
  const handoff = mainConversationMessages(messages).find((message) =>
    Boolean(getMessageHandoffSource(message)));
  const content = handoff?.content;
  return typeof content === 'string' ? content : '';
}

async function target(input: ToolReviewRejectRuntimeInput): Promise<EvalOutput> {
  let toolRunCount = 0;
  const reviewedTool = tool(async ({ command }: { command: string }) => {
    toolRunCount += 1;
    return `ran ${command}`;
  }, {
    name: input.reviewedTool,
    description: 'reviewed shell command',
    schema: z.object({ command: z.string() }),
  });

  const toolkits = [defineToolkit({
    name: 'eval_general',
    description: 'Mock general tools for reviewed tool-call rejection eval.',
    tools: [{
      tool: reviewedTool,
      review: {
          request: () => buildReviewSpec({
            view: { kind: 'plain', body: `Approve ${input.reviewedTool}?` },
            options: [
              {
                id: 'approve',
                label: 'Approve',
                decision: { type: 'approve' },
              },
              {
                id: input.rejectOptionId,
                label: 'Reject',
                decision: { type: 'reject' },
              },
            ],
          }),
      },
    }],
  })];

  const routeModel = createRouteModel();
  const subagentModel = new ToolReviewRejectSubagentModel(
    input.reviewedTool,
    input.firstToolCall,
    input.subagentFinalResponse,
  );
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: subagentModel,
    },
    actor: testActor,
    checkpoint: new MemorySaver(),
    capabilityPlannerRunner: {
      async invoke(_plannerInput) {
        return {
          result: 'next_task',
          next_task: {
            objective: input.delegatedTask,
            capability_intent: 'exercise reviewed tool rejection',
            capability_name: 'general',
            context_summary: null,
          },
          remaining_plan: [],
        };
      },
    },
  });
  const recorder = createSubagentInputRecorder();
  const config = {
    callbacks: recorder.callbacks,
    configurable: {
      thread_id: `eval-tool-review-reject-${Date.now()}-${randomUUID()}`,
      actor: testActor,
      capabilities: [defineCapability({
        name: 'general',
        description: 'Execute the reviewed tool rejection eval task.',
        uses: ['eval_general'],
        instructions: defineInstructionDocument({
          content: 'Use the requested reviewed tool and respond to rejection feedback.',
        }),
      })],
      toolkits,
    },
  };

  const interrupted = await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage(input.userMessage)]),
    config,
  ) as { __interrupt__?: Array<{ id?: string; value?: unknown }> };
  const interrupt = interrupted.__interrupt__?.[0];
  const payload = readInterruptPayload(interrupt?.value);
  const firstReviewId = payload?.reviews?.[0]?.review?.id ?? null;
  if (!interrupt?.id || !firstReviewId) {
    return {
      interrupted: Boolean(interrupt),
      firstReviewId,
      finalInterrupt: false,
      toolRunCount,
      rejectedToolResultSeenBySubagent: false,
      handoffPresent: false,
      handoffText: '',
      authorizationCount: 0,
      finalReply: '',
    };
  }

  const resumedRun = await graph.streamEvents(new Command({
    resume: {
      [interrupt.id]: {
        decisions: [{
          reviewId: firstReviewId,
          selectedOptionId: input.rejectOptionId,
        }],
      },
    },
  }), { version: 'v3', ...config });
  for await (const _event of resumedRun) {
    // Drain the stream so the final graph output is materialized.
  }
  const finalState = await resumedRun.output as {
    __interrupt__?: unknown;
    messages?: BaseMessage[];
    sessionToolAuthorizations?: { records?: unknown[] };
  };
  const messages = Array.isArray(finalState.messages)
    ? finalState.messages
    : [];
  const resumedSubagentInput = recorder.subagentInputs.at(-1) ?? [];
  const rejectedToolResultSeenBySubagent = resumedSubagentInput.some((message) =>
    ToolMessage.isInstance(message)
    && message.tool_call_id === input.firstToolCall.id);
  const handoffText = findHandoffText(messages);

  return {
    interrupted: true,
    firstReviewId,
    finalInterrupt: Boolean(finalState.__interrupt__),
    toolRunCount,
    rejectedToolResultSeenBySubagent,
    handoffPresent: Boolean(handoffText),
    handoffText,
    authorizationCount: finalState.sessionToolAuthorizations?.records?.length ?? 0,
    finalReply: readLastText(messages),
  };
}

function exactScore(
  key: string,
  actual: unknown,
  expected: unknown,
): ScoreResult {
  return {
    key,
    score: Object.is(actual, expected) ? 1 : 0,
    comment: Object.is(actual, expected)
      ? `Correct: ${String(actual)}`
      : `Expected ${String(expected)}, got ${String(actual)}`,
  };
}

function finalAnnounceScore(
  output: Partial<EvalOutput>,
  expected: ToolReviewRejectRuntimeExpected,
): ScoreResult {
  const text = output.handoffText ?? '';
  const missing = expected.expectedFinalAnnounceIncludes.filter((item) => !text.includes(item));
  return {
    key: 'final_announce_correct',
    score: missing.length === 0 ? 1 : 0,
    comment: missing.length === 0
      ? 'Subagent final announce contains all expected result terms.'
      : `Missing terms in final handoff announce: ${missing.join(', ')}`,
  };
}

function runEvaluators(
  output: Partial<EvalOutput>,
  expected: ToolReviewRejectRuntimeExpected,
): ScoreResult[] {
  return [
    exactScore('interrupted_correct', output.interrupted, expected.expectedInterrupted),
    exactScore('final_interrupt_correct', output.finalInterrupt, expected.expectedFinalInterrupt),
    exactScore('tool_run_count_correct', output.toolRunCount, expected.expectedToolRunCount),
    exactScore(
      'rejected_tool_result_seen_by_subagent',
      output.rejectedToolResultSeenBySubagent,
      expected.expectedRejectedToolResultSeenBySubagent,
    ),
    exactScore('handoff_correct', output.handoffPresent, expected.expectedHandoffPresent),
    exactScore('authorization_count_correct', output.authorizationCount, expected.expectedAuthorizationCount),
    finalAnnounceScore(output, expected),
  ];
}

function scorePasses(score: ScoreResult): boolean {
  return score.score === 1;
}

function traceIdFor(runName: string, caseId: string): string {
  const slug = `${runName}.${caseId}`
    .replace(/[^a-zA-Z0-9_.:-]/g, '-')
    .slice(0, 160);
  return `${slug}.${randomUUID()}`;
}

async function writeLangfuseResult(params: {
  config: ReturnType<typeof resolveLangfuseConfig>;
  runName: string;
  traceId: string;
  testCase: typeof toolReviewRejectRuntimeDataset.cases[number];
  row: EvalRow;
}) {
  await langfuseFetch(params.config, '/traces', {
    method: 'POST',
    body: JSON.stringify({
      id: params.traceId,
      name: 'tool-review-reject-runtime-eval',
      input: params.testCase.input,
      output: params.row.error
        ? { error: params.row.error, ...params.row.output }
        : params.row.output,
      metadata: {
        runName: params.runName,
        datasetName: toolReviewRejectRuntimeDataset.name,
        datasetItemId: params.testCase.id,
        caseName: params.testCase.name,
        tags: params.testCase.tags,
        durationMs: params.row.durationMs,
        ok: params.row.ok,
      },
    }),
  });

  for (const score of params.row.scores) {
    await langfuseFetch(params.config, '/scores', {
      method: 'POST',
      body: JSON.stringify({
        traceId: params.traceId,
        name: score.key,
        value: score.score,
        comment: score.comment,
      }),
    });
  }

  await langfuseFetch(params.config, '/dataset-run-items', {
    method: 'POST',
    body: JSON.stringify({
      runName: params.runName,
      datasetItemId: params.testCase.id,
      traceId: params.traceId,
    }),
  });
}

function printSummary(rows: EvalRow[]) {
  console.log('\n=== Langfuse tool-review reject eval complete ===');
  console.log(`Cases: ${rows.filter((row) => row.ok).length}/${rows.length} passed`);

  console.log('\nBy score dimension:');
  for (const key of scoreKeys) {
    const scores = rows.flatMap((row) => row.scores.filter((score) => score.key === key));
    const passed = scores.filter(scorePasses).length;
    console.log(`${key}: ${passed}/${scores.length} passed`);
  }

  const failed = rows.filter((row) => !row.ok);
  if (failed.length === 0) return;

  console.log('\nFailures:');
  for (const row of failed) {
    const failedScores = row.scores.filter((score) => !scorePasses(score));
    const comments = failedScores.map((score) => `${score.key}: ${score.comment ?? score.score}`).join(' | ');
    console.log(`- ${row.name}: ${row.error ?? comments}`);
  }
}

async function main() {
  const config = resolveLangfuseConfig();
  const cases = selectedCases();
  if (cases.length === 0) {
    throw new Error(`No eval cases selected. EVAL_CASES=${process.env.EVAL_CASES ?? '(unset)'}`);
  }

  const runName = process.env.LANGFUSE_RUN_NAME
    || `tool-review-reject-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`Running Langfuse tool-review reject eval: ${runName}`);
  console.log(`Dataset: ${toolReviewRejectRuntimeDataset.name}`);
  console.log(`Langfuse: ${config.baseUrl}`);
  console.log(`Cases: ${cases.length}\n`);

  const rows: EvalRow[] = [];
  for (const testCase of cases) {
    const started = performance.now();
    const traceId = traceIdFor(runName, testCase.id);
    try {
      const output = await target(testCase.input);
      const scores = runEvaluators(output, testCase.expected);
      const row = {
        id: testCase.id,
        name: testCase.name,
        suite: testCase.suite,
        tags: testCase.tags,
        ok: scores.every(scorePasses),
        durationMs: Math.round(performance.now() - started),
        scores,
        output,
      };
      await writeLangfuseResult({ config, runName, traceId, testCase, row });
      rows.push(row);
      console.log(`[${row.ok ? 'PASS' : 'FAIL'}] ${testCase.name} (${row.durationMs}ms)`);
    } catch (error) {
      const row = {
        id: testCase.id,
        name: testCase.name,
        suite: testCase.suite,
        tags: testCase.tags,
        ok: false,
        durationMs: Math.round(performance.now() - started),
        scores: [{ key: 'run_error', score: 0, comment: compactError(error) }],
        output: {},
        error: compactError(error),
      };
      await writeLangfuseResult({ config, runName, traceId, testCase, row });
      rows.push(row);
      console.log(`[ERROR] ${testCase.name} (${row.durationMs}ms): ${row.error}`);
    }
  }

  printSummary(rows);
  if (rows.some((row) => !row.ok)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
