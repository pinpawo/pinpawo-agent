import assert from 'node:assert/strict';
import test from 'node:test';
import { channelInvocationHint } from './channelInvocationHint';

test('Channel context supplies a separate preparation hint for admitted work', () => {
  const hint = channelInvocationHint();
  assert.deepEqual(Object.keys(hint).sort(), ['instruction', 'source']);
  assert.equal(hint.source, 'channel');
  assert.equal(typeof hint.instruction, 'string');
});
