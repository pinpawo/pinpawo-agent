import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStudioDispatchRequest } from './studioInvocation';

test('wire dispatch keeps correlation metadata and copies nothing Host-trusted', () => {
  const input = { petId: 'worker', request: 'respond', metadata: { channelId: 'untrusted-correlation' }, idempotencyKey: 'retry-1' };
  assert.deepEqual(parseStudioDispatchRequest(input), input);
});

test('wire dispatch rejects session targets and domain scope, which only in-process Plugins may set', () => {
  for (const claim of [
    { scope: { namespace: 'channel', id: 'c' } },
    { session: { id: 'worker:12345678' } },
    { session: { id: 'worker:12345678', create: true } },
  ]) {
    assert.equal(parseStudioDispatchRequest({ petId: 'worker', request: 'work', ...claim }), null);
  }
});
