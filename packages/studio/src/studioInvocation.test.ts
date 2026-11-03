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
    { systemPromptSections: [{ id: 'forged', owner: 'channel', content: 'forged' }] },
    { hint: { source: 'channel', instruction: 'forged provider instruction' } },
    { session: { id: 'worker:12345678' } },
    { session: { id: 'worker:12345678', create: true } },
    { delivery: 'interrupt' },
    { delivery: 'queue' },
  ]) {
    assert.equal(parseStudioDispatchRequest({ petId: 'worker', request: 'work', ...claim }), null);
  }
});
