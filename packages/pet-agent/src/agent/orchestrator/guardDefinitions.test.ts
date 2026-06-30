import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages/tool';
import {
  createOrchestratorGuardRegistry,
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  type OrchestratorGuardConfig,
} from './guardDefinitions';
import { setPinpetMeta } from './messageLanes';
import type { OrchestratorStateType } from './state';
import type { TaskActiveDelegation } from './types';

function baseState(over: Partial<OrchestratorStateType> = {}): OrchestratorStateType {
  return {
    messages: [],
    runDelegations: [],
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

const config: OrchestratorGuardConfig = {
  runIterationLimit: 25,
};

const activeDelegation: TaskActiveDelegation = {
  id: 'd1',
  lane: 'general',
  task: '做点事',
  contextSummary: null,
  transcriptRunId: 'run-1',
  status: 'awaiting_decision',
  resultPreview: null,
};

test('orchestrator guard registry exposes business guards by position', () => {
  const registry = createOrchestratorGuardRegistry();

  assert.deepEqual(
    registry
      .list(ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_ITERATION)
      .map((guard) => guard.name),
    [ORCHESTRATOR_GUARD_NAME.RUN_ITERATION_LIMIT],
  );
});

test('context compaction watermark guard uses main conversation provider usage only', () => {
  const registry = createOrchestratorGuardRegistry();
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

  const result = registry.check(ORCHESTRATOR_GUARD_NAME.CONTEXT_COMPACTION_WATERMARK, {
    state,
    config: {
      runIterationLimit: 25,
      contextWindowTokens: 1000,
      contextCompaction: {
        keepMessages: 1,
      },
    },
    position: ORCHESTRATOR_GUARD_POSITION.CONTEXT_COMPACTION,
  });

  assert.equal(result.status, 'pass');
});

test('context compaction watermark guard blocks when main provider usage crosses the unified watermark', () => {
  const registry = createOrchestratorGuardRegistry();
  const state = baseState({
    messages: [
      new HumanMessage('old request 1'),
      new AIMessage('old response 1'),
      new HumanMessage('old request 2'),
      usageMessage('latest response', 900),
    ],
  });

  const result = registry.check(ORCHESTRATOR_GUARD_NAME.CONTEXT_COMPACTION_WATERMARK, {
    state,
    config: {
      runIterationLimit: 25,
      contextWindowTokens: 1000,
      contextCompaction: {
        keepMessages: 1,
      },
    },
    position: ORCHESTRATOR_GUARD_POSITION.CONTEXT_COMPACTION,
  });

  assert.equal(result.status, 'block');
  assert.deepEqual(result.details, {
    mainMessageCount: 4,
    keepMessages: 1,
    latestInputTokens: 900,
    watermarkTokens: 750,
  });
});

test('delegation outcome guard blocks handoff for a limit_reached active delegation', async () => {
  const registry = createOrchestratorGuardRegistry();
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

  const result = registry.check(ORCHESTRATOR_GUARD_NAME.DELEGATION_OUTCOME_DECISION, {
    state,
    config,
    position: ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_DECISION,
  });
  assert.equal(result.status, 'block');

  const run = await registry.run(ORCHESTRATOR_GUARD_NAME.DELEGATION_OUTCOME_DECISION, {
    state,
    config,
    position: ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_DECISION,
  });
  assert.equal(run.result.status, 'block');
  assert.deepEqual(run.update, {
    canHandoffActiveDelegation: false,
  });
});

test('run iteration limit guard uses resolved config and returns an inline stop update', async () => {
  const registry = createOrchestratorGuardRegistry();
  const state = baseState({
    taskActiveDelegation: activeDelegation,
    runIterationCount: 5,
  });

  const result = registry.check(ORCHESTRATOR_GUARD_NAME.RUN_ITERATION_LIMIT, {
    state,
    config: { runIterationLimit: 5 },
    position: ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_ITERATION,
  });
  assert.equal(result.status, 'block');

  const run = await registry.run(ORCHESTRATOR_GUARD_NAME.RUN_ITERATION_LIMIT, {
    state,
    config: { runIterationLimit: 5 },
    position: ORCHESTRATOR_GUARD_POSITION.DELEGATION_OUTCOME_ITERATION,
  });
  const patch = run.update as Record<string, unknown>;

  assert.equal(run.result.status, 'block');
  assert.equal(patch.runPendingFinalReply, 'inline');
  assert.equal(patch.runIterationCount, 0);
  assert.equal(patch.runPendingDelegation, null);
  assert.ok(Array.isArray(patch.messages) && patch.messages.length === 1);
});
