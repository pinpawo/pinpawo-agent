import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages/tool';
import { evaluateGuard } from '../../guards';
import {
  ACTIVE_DELEGATION_LIMIT_REACHED,
  contextCompactionWatermarkGuard,
  delegationOutcomeDecisionGuard,
  forcedCapabilitySeedGuard,
  ORCHESTRATOR_GUARD_POSITION,
  RUN_STATE_RESET_REQUIRED,
  runIterationLimitGuard,
  runStateResetGuard,
  type ForcedCapabilitySeedDetails,
} from './guardDefinitions';
import {
  createDelegationOutcomeIterationGuardNode,
} from './runtime/guards/nodes';
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

function stubCapability(name: string, description: string) {
  return {
    name,
    description,
    createRuntime: () => {
      throw new Error('not used in guard tests');
    },
  };
}

const activeDelegation: TaskActiveDelegation = {
  id: 'd1',
  lane: 'general',
  task: '做点事',
  contextSummary: null,
  transcriptRunId: 'run-1',
  status: 'awaiting_decision',
  resultPreview: null,
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
    lane: 'general',
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
      keepMessages: 1,
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
      keepMessages: 1,
    },
    position: ORCHESTRATOR_GUARD_POSITION.CONTEXT_COMPACTION,
  });

  assert.equal(outcome.kind, 'maintain');
  assert.deepEqual(outcome.kind === 'maintain' && outcome.details, {
    mainMessageCount: 4,
    keepMessages: 1,
    latestInputTokens: 900,
    watermarkTokens: 750,
  });
});

test('forced capability seed guard derives the seeded search state once', () => {
  const outcome = evaluateGuard(forcedCapabilitySeedGuard, {
    state: baseState({
      runCapabilitySearchState: { query: null, attempted: false, candidates: [] },
    }),
    config: {
      forcedCapabilityNames: ['weather', 'weather', 'missing'],
      capabilities: [
        stubCapability('weather', '查天气'),
        stubCapability('other', '其他'),
      ],
    },
    position: ORCHESTRATOR_GUARD_POSITION.CAPABILITY_SEARCH,
  });

  assert.equal(outcome.kind, 'derive');
  const details = (outcome.kind === 'derive' && outcome.details) as ForcedCapabilitySeedDetails;
  assert.deepEqual(details.seededCapabilityNames, ['weather']);
  assert.equal(details.runCapabilitySearchState.attempted, true);
  assert.equal(details.runCapabilitySearchState.candidates.length, 1);
  assert.equal(details.runCapabilitySearchState.candidates[0]?.name, 'weather');
});

test('forced capability seed guard proceeds when a search was already attempted', () => {
  const outcome = evaluateGuard(forcedCapabilitySeedGuard, {
    state: baseState({
      runCapabilitySearchState: { query: 'q', attempted: true, candidates: [] },
    }),
    config: {
      forcedCapabilityNames: ['weather'],
      capabilities: [stubCapability('weather', '查天气')],
    },
    position: ORCHESTRATOR_GUARD_POSITION.CAPABILITY_SEARCH,
  });

  assert.equal(outcome.kind, 'proceed');
});

test('delegation outcome guard derives handoff refusal for a limit_reached active delegation', async () => {
  const announce = new AIMessage('limit reached');
  setPinpetMeta(announce, {
    lane: 'general',
    isAnnounce: true,
    completionReason: 'limit_reached',
    runId: 'run-1',
    delegationId: 'd1',
  });
  const state = baseState({
    taskActiveDelegation: activeDelegation,
    messages: [announce],
  });

  const outcome = evaluateGuard(delegationOutcomeDecisionGuard, {
    state,
    config: {},
    position: ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_DECISION,
  });
  assert.equal(outcome.kind, 'derive');
  assert.equal(outcome.kind === 'derive' && outcome.reason, ACTIVE_DELEGATION_LIMIT_REACHED);
});

test('guard nodes push decision records onto the LangGraph custom stream writer', async () => {
  const chunks: unknown[] = [];
  const runnableConfig = {
    writer: (chunk: unknown) => chunks.push(chunk),
  } as Parameters<ReturnType<typeof createDelegationOutcomeIterationGuardNode>>[1] & {
    writer: (chunk: unknown) => void;
  };

  const node = createDelegationOutcomeIterationGuardNode({ orchestratorMaxIterations: 5 });
  await node(baseState({
    taskActiveDelegation: activeDelegation,
    runIterationCount: 5,
  }), runnableConfig);

  const records = chunks.filter(isGuardDecisionStreamChunk);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.name, GUARD_DECISION_EVENT);
  assert.deepEqual(records[0]?.data, {
    guard: 'run_iteration_limit',
    position: 'orchestrator.delegation_outcome_iteration',
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

test('run iteration limit guard stops at the resolved limit and the node returns an inline stop command', async () => {
  const state = baseState({
    taskActiveDelegation: activeDelegation,
    runIterationCount: 5,
  });

  const outcome = evaluateGuard(runIterationLimitGuard, {
    state,
    config: { runIterationLimit: 5 },
    position: ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_ITERATION,
  });
  assert.equal(outcome.kind, 'stop');
  assert.deepEqual(outcome.kind === 'stop' && outcome.details, {
    runIterationCount: 5,
    runIterationLimit: 5,
  });

  const node = createDelegationOutcomeIterationGuardNode({ orchestratorMaxIterations: 5 });
  const command = await node(state) as {
    goto?: string | string[];
    update?: Record<string, unknown>;
  };

  assert.deepEqual(command.goto, ['__end__']);
  assert.equal(command.update?.runIterationCount, 0);
  assert.equal(command.update?.runNextDelegation, null);
  assert.ok(Array.isArray(command.update?.messages) && command.update.messages.length === 1);

  const belowLimitNode = createDelegationOutcomeIterationGuardNode({ orchestratorMaxIterations: 25 });
  const continueCommand = await belowLimitNode(state) as { goto?: string | string[] };
  assert.deepEqual(continueCommand.goto, ['delegationOutcomeDecision']);
});
