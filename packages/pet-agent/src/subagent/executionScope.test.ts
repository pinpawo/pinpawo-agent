import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readSubagentExecutionScope,
  SUBAGENT_EXECUTION_SCOPE_CONFIG_KEY,
  withSubagentExecutionScope,
} from './executionScope';

test('subagent execution scope preserves the surrounding runnable config', () => {
  const controller = new AbortController();
  const scope = {
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId: 'delegation-1',
  };
  const config = withSubagentExecutionScope({
    signal: controller.signal,
    configurable: {
      existing: 'value',
    },
  }, scope);

  assert.equal(config.signal, controller.signal);
  assert.equal(config.configurable?.existing, 'value');
  assert.deepEqual(
    config.configurable?.[SUBAGENT_EXECUTION_SCOPE_CONFIG_KEY],
    scope,
  );
  assert.deepEqual(readSubagentExecutionScope(config), scope);
});

test('subagent execution scope rejects malformed configurable values', () => {
  assert.equal(readSubagentExecutionScope(), null);
  assert.equal(readSubagentExecutionScope({
    configurable: {
      [SUBAGENT_EXECUTION_SCOPE_CONFIG_KEY]: {
        threadId: 'thread-1',
        runId: '',
        delegationId: 'delegation-1',
      },
    },
  }), null);
});
