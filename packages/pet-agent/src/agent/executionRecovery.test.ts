import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { prepareRuntimeExecution, readRuntimeRecoveryDescriptor } from './executionRecovery';

test('runtime allocates independent identities and exposes only typed recovery descriptions', () => {
  const first = prepareRuntimeExecution([new HumanMessage('first')], 'opaque-thread');
  const second = prepareRuntimeExecution([new HumanMessage('second')], 'opaque-thread');
  assert.notEqual(first.identity.runId, second.identity.runId);
  assert.notEqual(first.identity.taskId, second.identity.taskId);
  assert.equal(first.identity.threadId, 'opaque-thread');
  assert.equal(first.input.runId, first.identity.runId);
  const snapshot = { values: { ...first.input, messages: [new AIMessage('public result')] }, next: [], tasks: [] };
  const descriptor = readRuntimeRecoveryDescriptor(snapshot, 'opaque-thread');
  assert.equal(descriptor.state, 'completed');
  assert.deepEqual(descriptor.identity, first.identity);
  assert.equal(descriptor.reply, 'public result');
  assert.equal('messages' in descriptor, false);
  assert.equal(readRuntimeRecoveryDescriptor({ ...snapshot, next: ['pending'] }, 'opaque-thread').state, 'unknown');
  assert.equal(readRuntimeRecoveryDescriptor({ ...snapshot, values: { ...snapshot.values, runTerminalError: { message: 'failed' } } }, 'opaque-thread').state, 'failed');
  assert.equal(readRuntimeRecoveryDescriptor({ values: {}, next: [], tasks: [] }, 'opaque-thread').state, 'empty');
});
