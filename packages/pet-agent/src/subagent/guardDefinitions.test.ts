import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  createSubagentGuardRegistry,
  SUBAGENT_GUARD_NAME,
  SUBAGENT_GUARD_POSITION,
  type SubagentState,
} from './index';
import { isSubagentGuardStopMessage } from '../guardStop';

function baseState(over: Partial<SubagentState> = {}): SubagentState {
  return {
    instructions: [],
    messages: [],
    iterationCount: 0,
    maxIterations: 100,
    ...over,
  } as SubagentState;
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

test('subagent guard registry exposes guards by position', () => {
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

test('context rewrite watermark guard passes when no context policy is set', () => {
  const registry = createSubagentGuardRegistry();
  const state = baseState({
    messages: [usageMessage('test', 900)],
    contextWindowTokens: 1000,
  });

  const result = registry.check(SUBAGENT_GUARD_NAME.CONTEXT_REWRITE_WATERMARK, {
    state,
    config: {},
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_POLICY,
  });

  assert.equal(result.status, 'pass');
});

test('context rewrite watermark guard passes when context policy exists but tokens are below watermark', () => {
  const registry = createSubagentGuardRegistry();
  const state = baseState({
    messages: [usageMessage('below', 400)],
    contextWindowTokens: 1000,
    contextPolicy: { evictToolResults: { keepRecent: 0 } },
  });

  const result = registry.check(SUBAGENT_GUARD_NAME.CONTEXT_REWRITE_WATERMARK, {
    state,
    config: {},
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_POLICY,
  });

  assert.equal(result.status, 'pass');
});

test('context rewrite watermark guard blocks when tokens cross the watermark', () => {
  const registry = createSubagentGuardRegistry();
  const state = baseState({
    messages: [usageMessage('above', 900)],
    contextWindowTokens: 1000,
    contextPolicy: { evictToolResults: { keepRecent: 0 } },
  });

  const result = registry.check(SUBAGENT_GUARD_NAME.CONTEXT_REWRITE_WATERMARK, {
    state,
    config: {},
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_POLICY,
  });

  assert.equal(result.status, 'block');
  assert.deepEqual(result.details, {
    latestInputTokens: 900,
    watermarkTokens: 750,
  });
});

test('context rewrite watermark guard passes when contextWindowTokens is invalid', () => {
  const registry = createSubagentGuardRegistry();
  const state = baseState({
    messages: [usageMessage('test', 900)],
    contextWindowTokens: 0,
    contextPolicy: { evictToolResults: { keepRecent: 0 } },
  });

  const result = registry.check(SUBAGENT_GUARD_NAME.CONTEXT_REWRITE_WATERMARK, {
    state,
    config: {},
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_POLICY,
  });

  assert.equal(result.status, 'pass');
});

test('iteration limit guard passes when iterationCount is below maxIterations', () => {
  const registry = createSubagentGuardRegistry();
  const state = baseState({
    iterationCount: 4,
    maxIterations: 5,
  });

  const result = registry.check(SUBAGENT_GUARD_NAME.ITERATION_LIMIT, {
    state,
    config: {},
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION,
  });

  assert.equal(result.status, 'pass');
});

test('iteration limit guard blocks when iterationCount reaches maxIterations', () => {
  const registry = createSubagentGuardRegistry();
  const state = baseState({
    iterationCount: 5,
    maxIterations: 5,
  });

  const result = registry.check(SUBAGENT_GUARD_NAME.ITERATION_LIMIT, {
    state,
    config: {},
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION,
  });

  assert.equal(result.status, 'block');
  assert.deepEqual(result.details, {
    iterationCount: 5,
    maxIterations: 5,
  });
});

test('iteration limit guard returns a stop notice on block', async () => {
  const registry = createSubagentGuardRegistry();
  const state = baseState({
    iterationCount: 5,
    maxIterations: 5,
  });

  const run = await registry.run(SUBAGENT_GUARD_NAME.ITERATION_LIMIT, {
    state,
    config: {},
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION,
  });

  assert.equal(run.result.status, 'block');
  assert.ok(run.update?.messages);
  assert.equal(run.update!.messages!.length, 1);
  assert.equal(isSubagentGuardStopMessage(run.update!.messages![0]), true);
});

test('iteration limit guard passes when maxIterations is invalid', () => {
  const registry = createSubagentGuardRegistry();
  const state = baseState({
    iterationCount: 100,
    maxIterations: 0,
  });

  const result = registry.check(SUBAGENT_GUARD_NAME.ITERATION_LIMIT, {
    state,
    config: {},
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION,
  });

  assert.equal(result.status, 'pass');
});

test('iteration limit guard handler returns null on pass', async () => {
  const registry = createSubagentGuardRegistry();
  const state = baseState({
    iterationCount: 3,
    maxIterations: 5,
  });

  const run = await registry.run(SUBAGENT_GUARD_NAME.ITERATION_LIMIT, {
    state,
    config: {},
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION,
  });

  assert.equal(run.result.status, 'pass');
  assert.equal(run.update, null);
});
