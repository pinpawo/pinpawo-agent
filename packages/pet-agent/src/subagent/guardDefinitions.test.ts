import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  createSubagentGuardRegistry,
  SUBAGENT_GUARD_NAME,
  SUBAGENT_GUARD_POSITION,
  type SubagentState,
} from './guardDefinitions';
import { readSubagentGuardStopReason } from './guardStop';
import { createSubagentMiddlewareGuardRunner } from './middlewareGuardRunner';

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

function baseState(over: Partial<SubagentState> = {}): SubagentState {
  return {
    instructions: [],
    operations: {},
    messages: [new HumanMessage('do the task')],
    iterationCount: 1,
    maxIterations: 4,
    ...over,
  };
}

test('subagent guard registry exposes middleware guards by position', () => {
  const registry = createSubagentGuardRegistry();

  assert.deepEqual(
    registry
      .list(SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_POLICY)
      .map((guard) => guard.name),
    [SUBAGENT_GUARD_NAME.CONTEXT_REWRITE_WATERMARK],
  );
  assert.deepEqual(
    registry
      .list(SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION)
      .map((guard) => guard.name),
    [SUBAGENT_GUARD_NAME.ITERATION_LIMIT],
  );
});

test('subagent context rewrite watermark guard blocks from provider usage only', () => {
  const registry = createSubagentGuardRegistry();
  const state = baseState({
    contextPolicy: {
      rewrite: (messages) => messages,
    },
    messages: [
      new HumanMessage('do the task'),
      usageMessage('previous provider usage', 900),
    ],
  });

  const result = registry.check(SUBAGENT_GUARD_NAME.CONTEXT_REWRITE_WATERMARK, {
    state,
    config: {
      contextWindowTokens: 1000,
    },
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_POLICY,
  });

  assert.equal(result.status, 'block');
  assert.deepEqual(result.details, {
    latestInputTokens: 900,
    watermarkTokens: 750,
  });
});

test('subagent iteration limit guard returns a marked stop message patch', async () => {
  const registry = createSubagentGuardRegistry();
  const state = baseState({
    iterationCount: 5,
    maxIterations: 4,
  });

  const run = await registry.run(SUBAGENT_GUARD_NAME.ITERATION_LIMIT, {
    state,
    config: {},
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION,
  });

  assert.equal(run.result.status, 'block');
  assert.equal(run.update?.messages?.length, 1);
  assert.match(String(run.update?.messages?.[0]?.content), /attempted 5, limit 4/);
  assert.equal(
    readSubagentGuardStopReason(run.update?.messages?.[0] as AIMessage),
    'subagent_iteration_limit_reached',
  );
});

test('subagent middleware guard runner snapshots hook-local state', async () => {
  const runner = createSubagentMiddlewareGuardRunner({
    inputState: baseState({
      maxIterations: 99,
      messages: [new HumanMessage('initial')],
    }),
    maxIterations: 4,
  });

  const run = await runner(
    SUBAGENT_GUARD_NAME.ITERATION_LIMIT,
    SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION,
    {
      messages: [new HumanMessage('runtime')],
      iterationCount: 5,
    },
  );

  assert.equal(run.result.status, 'block');
  assert.equal(run.update?.messages?.length, 1);
  assert.equal(
    readSubagentGuardStopReason(run.update?.messages?.[0] as AIMessage),
    'subagent_iteration_limit_reached',
  );
});
