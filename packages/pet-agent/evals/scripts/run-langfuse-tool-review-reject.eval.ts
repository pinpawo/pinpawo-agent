import { randomUUID } from 'node:crypto';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command, MemorySaver } from '@langchain/langgraph';
import { FakeToolCallingModel } from 'langchain';
import { z } from 'zod';
import type { AgentActor, AgentModels } from '../../src/types/agent';
import { createOrchestratorGraph, buildOrchestratorRunInput } from '../../src/agent/createAgentRuntime';
import { buildReviewSpec } from '../../src/agent/orchestrator/review/reviewSpec';
import {
  getMessageHandoffSource,
  mainConversationMessages,
  readLatestAnnounce,
  readLatestAnnounceCompletionReason,
} from '../../src/agent/orchestrator/messageLanes';
import { isToolReviewCancellationMessage } from '../../src/subagent/completionReason';
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
  retryToolResultPresent: boolean;
  cancellationHandoffPresent: boolean;
  activeDelegationRetained: boolean;
  cancellationCompletionReason: string | null;
  cancelledToolResultRetained: boolean;
  cancellationAnnounceText: string;
  followUpReusedTranscript: boolean;
  completedHandoffPresent: boolean;
  finalActiveDelegationPresent: boolean;
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
  'retry_tool_result_correct',
  'cancellation_handoff_correct',
  'active_delegation_retained',
  'cancellation_completion_reason_correct',
  'cancelled_tool_result_retained',
  'follow_up_reused_transcript',
  'completed_handoff_correct',
  'final_active_delegation_correct',
  'authorization_count_correct',
  'cancellation_announce_correct',
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

function createRouteModel(task: string): AgentModels['act'] {
  let decisionCount = 0;
  return {
    invoke: async () => new AIMessage('已停止本次工具调用。'),
    bindTools: () => ({
      invoke: async () => new AIMessage(''),
    }),
    withStructuredOutput: () => ({
      invoke: async () => {
        decisionCount += 1;
        if (decisionCount === 1) {
          return {
            action: 'direct_task',
            task,
            context_summary: null,
          };
        }
        if (decisionCount === 2) {
          return {
            outcome: 'await_user',
            gap_note: '工具调用已取消，保留现有执行上下文。',
          };
        }
        if (decisionCount === 3) {
          return {
            outcome: 'continue',
            gap_note: '不要重试工具，直接整理已有结果。',
          };
        }
        return { outcome: 'goal_done', gap_note: null };
      },
    }),
  } as unknown as AgentModels['act'];
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

function readToolResult(messages: BaseMessage[], toolCallId: string) {
  return messages.find((message): message is ToolMessage =>
    ToolMessage.isInstance(message)
    && message.tool_call_id === toolCallId);
}

function readLastText(messages: BaseMessage[]): string {
  const content = messages.at(-1)?.content;
  return typeof content === 'string' ? content : '';
}

function findHandoff(messages: BaseMessage[]) {
  return mainConversationMessages(messages).find((message) =>
    Boolean(getMessageHandoffSource(message)));
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
    tools: [reviewedTool],
    policy: {
      toolReview: {
        [input.reviewedTool]: {
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
      },
    },
  })];

  const routeModel = createRouteModel(input.delegatedTask);
  const subagentModel = new FakeToolCallingModel({
    toolCalls: [
      [{
        id: input.firstToolCall.id,
        name: input.reviewedTool,
        args: input.firstToolCall.args,
      }],
      [{
        id: input.retryToolCall.id,
        name: input.reviewedTool,
        args: input.retryToolCall.args,
      }],
      [],
    ],
  });
  const graph = createOrchestratorGraph({
    models: {
      act: routeModel,
      observe: routeModel,
      subagent: subagentModel,
    },
    actor: testActor,
    checkpoint: new MemorySaver(),
  });
  const recorder = createSubagentInputRecorder();
  const config = {
    callbacks: recorder.callbacks,
    configurable: {
      thread_id: `eval-tool-review-reject-${Date.now()}-${randomUUID()}`,
      actor: testActor,
      capabilities: [],
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
      retryToolResultPresent: false,
      cancellationHandoffPresent: false,
      activeDelegationRetained: false,
      cancellationCompletionReason: null,
      cancelledToolResultRetained: false,
      cancellationAnnounceText: '',
      followUpReusedTranscript: false,
      completedHandoffPresent: false,
      finalActiveDelegationPresent: false,
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
  const cancellationState = await resumedRun.output as {
    __interrupt__?: unknown;
    messages?: BaseMessage[];
    sessionToolAuthorizations?: unknown[];
    taskActiveDelegation?: {
      id: string;
      transcriptRunId: string;
    } | null;
  };
  const cancellationMessages = Array.isArray(cancellationState.messages)
    ? cancellationState.messages
    : [];
  const activeDelegation = cancellationState.taskActiveDelegation ?? null;
  const cancellationAnnounce = activeDelegation
    ? readLatestAnnounce(cancellationMessages, {
        runId: activeDelegation.transcriptRunId,
        delegationId: activeDelegation.id,
      })
    : null;
  const cancellationCompletionReason = activeDelegation
    ? readLatestAnnounceCompletionReason(cancellationMessages, {
        runId: activeDelegation.transcriptRunId,
        delegationId: activeDelegation.id,
      })
    : null;

  // The next turn must resume the retained lane, not start a fresh delegation.
  // Skip the fake model's deliberately forbidden retry proposal so the resumed
  // invocation emits a tool-free deliverable and completes normally.
  subagentModel.index = 2;
  const completedState = await graph.invoke(
    buildOrchestratorRunInput([new HumanMessage(input.followUpMessage)]),
    config,
  ) as {
    __interrupt__?: unknown;
    messages?: BaseMessage[];
    sessionToolAuthorizations?: unknown[];
    taskActiveDelegation?: unknown;
  };
  const completedMessages = Array.isArray(completedState.messages)
    ? completedState.messages
    : [];
  const resumedSubagentInput = recorder.subagentInputs.at(-1) ?? [];
  const followUpReusedTranscript = resumedSubagentInput.some((message) =>
    ToolMessage.isInstance(message)
    && message.tool_call_id === input.firstToolCall.id)
    && resumedSubagentInput.some(isToolReviewCancellationMessage);

  return {
    interrupted: true,
    firstReviewId,
    finalInterrupt: Boolean(cancellationState.__interrupt__ || completedState.__interrupt__),
    toolRunCount,
    retryToolResultPresent: Boolean(
      readToolResult(cancellationMessages, input.retryToolCall.id),
    ),
    cancellationHandoffPresent: Boolean(findHandoff(cancellationMessages)),
    activeDelegationRetained: Boolean(activeDelegation),
    cancellationCompletionReason,
    cancelledToolResultRetained: Boolean(
      readToolResult(cancellationMessages, input.firstToolCall.id),
    ),
    cancellationAnnounceText: cancellationAnnounce?.text ?? '',
    followUpReusedTranscript,
    completedHandoffPresent: Boolean(findHandoff(completedMessages)),
    finalActiveDelegationPresent: Boolean(completedState.taskActiveDelegation),
    authorizationCount: completedState.sessionToolAuthorizations?.length ?? 0,
    finalReply: readLastText(completedMessages),
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

function cancellationAnnounceScore(
  output: Partial<EvalOutput>,
  expected: ToolReviewRejectRuntimeExpected,
): ScoreResult {
  const text = output.cancellationAnnounceText ?? '';
  const missing = expected.expectedCancellationAnnounceIncludes.filter((item) => !text.includes(item));
  return {
    key: 'cancellation_announce_correct',
    score: missing.length === 0 ? 1 : 0,
    comment: missing.length === 0
      ? 'Cancellation announce contains all expected terms.'
      : `Missing terms in retained cancellation announce: ${missing.join(', ')}`,
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
    exactScore('retry_tool_result_correct', output.retryToolResultPresent, expected.expectedRetryToolResultPresent),
    exactScore(
      'cancellation_handoff_correct',
      output.cancellationHandoffPresent,
      expected.expectedCancellationHandoffPresent,
    ),
    exactScore(
      'active_delegation_retained',
      output.activeDelegationRetained,
      expected.expectedActiveDelegationRetained,
    ),
    exactScore(
      'cancellation_completion_reason_correct',
      output.cancellationCompletionReason,
      expected.expectedCancellationCompletionReason,
    ),
    exactScore(
      'cancelled_tool_result_retained',
      output.cancelledToolResultRetained,
      expected.expectedCancelledToolResultRetained,
    ),
    exactScore(
      'follow_up_reused_transcript',
      output.followUpReusedTranscript,
      expected.expectedFollowUpReusedTranscript,
    ),
    exactScore(
      'completed_handoff_correct',
      output.completedHandoffPresent,
      expected.expectedCompletedHandoffPresent,
    ),
    exactScore(
      'final_active_delegation_correct',
      output.finalActiveDelegationPresent,
      expected.expectedFinalActiveDelegationPresent,
    ),
    exactScore('authorization_count_correct', output.authorizationCount, expected.expectedAuthorizationCount),
    cancellationAnnounceScore(output, expected),
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
