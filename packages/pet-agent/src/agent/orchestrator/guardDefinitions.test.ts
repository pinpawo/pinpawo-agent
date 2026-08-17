import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages/tool';
import { evaluateGuard } from '../../guards';
import {
  contextCompactionWatermarkGuard,
  ORCHESTRATOR_GUARD_POSITION,
  RUN_STATE_RESET_REQUIRED,
  runIterationLimitGuard,
  runStateResetGuard,
} from './guardDefinitions';
import {
  createAfterPlannerBoundaryIterationGuard,
} from './runtime/routes/afterPlannerBoundaryIterationGuard';
import {
  GUARD_DECISION_EVENT,
  guardDecisionEmitter,
  isGuardDecisionStreamChunk,
} from './runtime/guards/decisionEvents';
import { setPinpetMeta } from './messageLanes';
import type { OrchestratorStateType } from './state';
import type { TaskActiveDelegation } from './types';

function baseState(over: Partial<OrchestratorStateType> = {}): OrchestratorStateType {
  return {
    messages: [],
    runDelegationSummaries: [],
    runIterationCount: 0,
    taskActiveDelegation: null,
    runId: 'run-1',
    ...over,
  } as unknown as OrchestratorStateType;
}

function usageMessage(content: string, inputTokens: number) {
  return new AIMessage({
    content,
    usage_metadata: {
      input_tokens: inputTokens,
      output_tokens: 10,
      total_tokens: inputTokens + 10,
    },
  });
}

const activeDelegation: TaskActiveDelegation = {
  id: 'd1',
  lane: 'capability:general',
  task: '做点事',
  contextSummary: null,
  transcriptRunId: 'run-1',
  traceId: 'trace-1',
  status: 'awaiting_decision',
  resultPreview: null,
  userRequest: '做点事',
};

test('run state reset guard derives a reset only when the run id is missing', () => {
  const proceed = evaluateGuard(runStateResetGuard, {
    state: baseState(),
    config: {},
    position: ORCHESTRATOR_GUARD_POSITION.PREPARE,
  });
  assert.equal(proceed.kind, 'proceed');

  const derive = evaluateGuard(runStateResetGuard, {
    state: baseState({ runId: undefined }),
    config: {},
    position: ORCHESTRATOR_GUARD_POSITION.PREPARE,
  });
  assert.equal(derive.kind, 'derive');
  assert.equal(derive.kind === 'derive' && derive.reason, RUN_STATE_RESET_REQUIRED);
});

test('context compaction watermark guard uses main conversation provider usage only', () => {
  const noisyToolResult = new ToolMessage({
    content: `lane noise ${'x'.repeat(3200)}`,
    tool_call_id: 'call-noise',
  });
  setPinpetMeta(noisyToolResult, {
    lane: 'capability:general',
    runId: 'run-1',
    delegationId: 'delegation-noise',
  });
  const state = baseState({
    messages: [
      new HumanMessage('short request'),
      usageMessage('short response', 400),
      noisyToolResult,
    ],
  });

  const outcome = evaluateGuard(contextCompactionWatermarkGuard, {
    state,
    config: {
      contextWindowTokens: 1000,
    },
    position: ORCHESTRATOR_GUARD_POSITION.CONTEXT_COMPACTION,
  });

  assert.equal(outcome.kind, 'proceed');
});

test('context compaction watermark guard maintains when main provider usage crosses the unified watermark', () => {
  const state = baseState({
    messages: [
      new HumanMessage('old request 1'),
      new AIMessage('old response 1'),
      new HumanMessage('old request 2'),
      usageMessage('latest response', 900),
    ],
  });

  const outcome = evaluateGuard(contextCompactionWatermarkGuard, {
    state,
    config: {
      contextWindowTokens: 1000,
    },
    position: ORCHESTRATOR_GUARD_POSITION.CONTEXT_COMPACTION,
  });

  assert.equal(outcome.kind, 'maintain');
  assert.deepEqual(outcome.kind === 'maintain' && outcome.details, {
    mainMessageCount: 4,
    keepMessages: 10,
    latestInputTokens: 900,
    watermarkTokens: 750,
  });
});

test('context compaction watermark guard has no message-count trigger threshold', () => {
  const state = baseState({
    messages: [
      new HumanMessage('one very large request'),
      usageMessage('latest response', 900),
    ],
  });

  const outcome = evaluateGuard(contextCompactionWatermarkGuard, {
    state,
    config: { contextWindowTokens: 1000 },
    position: ORCHESTRATOR_GUARD_POSITION.CONTEXT_COMPACTION,
  });

  assert.equal(outcome.kind, 'maintain');
  assert.deepEqual(outcome.kind === 'maintain' && outcome.details, {
    mainMessageCount: 2,
    keepMessages: 10,
    latestInputTokens: 900,
    watermarkTokens: 750,
  });
});

test('context compaction watermark guard subtracts the generation reserve', () => {
  const state = baseState({
    messages: [
      new HumanMessage('old request'),
      usageMessage('latest response', 600),
    ],
  });

  const outcome = evaluateGuard(contextCompactionWatermarkGuard, {
    state,
    config: {
      contextWindowTokens: 1000,
      generationReserveTokens: 200,
    },
    position: ORCHESTRATOR_GUARD_POSITION.CONTEXT_COMPACTION,
  });

  assert.equal(outcome.kind, 'maintain');
  assert.deepEqual(outcome.kind === 'maintain' && outcome.details, {
    mainMessageCount: 2,
    keepMessages: 10,
    latestInputTokens: 600,
    watermarkTokens: 600,
  });
});

test('guard routes push decision records onto the LangGraph custom stream writer', () => {
  const chunks: unknown[] = [];
  const runnableConfig = {
    writer: (chunk: unknown) => chunks.push(chunk),
  } as Parameters<ReturnType<typeof createAfterPlannerBoundaryIterationGuard>>[1] & {
    writer: (chunk: unknown) => void;
  };

  const route = createAfterPlannerBoundaryIterationGuard({ orchestratorMaxIterations: 5 });
  route(baseState({
    taskActiveDelegation: activeDelegation,
    runIterationCount: 5,
  }), runnableConfig);

  const records = chunks.filter(isGuardDecisionStreamChunk);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.name, GUARD_DECISION_EVENT);
  assert.deepEqual(records[0]?.data, {
    guard: 'run_iteration_limit',
    position: 'orchestrator.planner_boundary_iteration',
    outcome: {
      kind: 'stop',
      reason: 'run_iteration_limit_reached',
      details: { runIterationCount: 5, runIterationLimit: 5 },
    },
    runId: 'run-1',
    iteration: 5,
  });
});

test('guard decision emitter is a no-op without a runnable config', () => {
  const emit = guardDecisionEmitter(undefined);
  // Must not throw.
  emit({
    guard: 'run_iteration_limit',
    position: 'orchestrator.delegation_outcome_iteration',
    outcome: { kind: 'proceed' },
  });
});

test('run iteration limit guard routes through answer at the resolved limit', () => {
  const state = baseState({
    taskActiveDelegation: activeDelegation,
    runIterationCount: 5,
  });

  const outcome = evaluateGuard(runIterationLimitGuard, {
    state,
    config: { runIterationLimit: 5 },
    position: ORCHESTRATOR_GUARD_POSITION.PLANNER_BOUNDARY_ITERATION,
  });
  assert.equal(outcome.kind, 'stop');
  assert.deepEqual(outcome.kind === 'stop' && outcome.details, {
    runIterationCount: 5,
    runIterationLimit: 5,
  });

  const atLimitRoute = createAfterPlannerBoundaryIterationGuard({ orchestratorMaxIterations: 5 });
  assert.equal(atLimitRoute(state), 'answer');

  const belowLimitRoute = createAfterPlannerBoundaryIterationGuard({ orchestratorMaxIterations: 25 });
  assert.equal(belowLimitRoute(state), 'capabilityPlanner');
});
