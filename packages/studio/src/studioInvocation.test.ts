import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStudioDispatchRequest } from './studioInvocation';

test('wire dispatch keeps correlation metadata and copies nothing Host-trusted', () => {
  const input = { petId: 'worker', request: 'respond', metadata: { channelId: 'untrusted-correlation' }, idempotencyKey: 'retry-1' };
  assert.deepEqual(parseStudioDispatchRequest(input), input);
});

test('wire dispatch rejects session targets, scope and attachments reserved for in-process Plugins', () => {
  for (const claim of [
    { scope: { namespace: 'channel', id: 'c' } },
    { systemPromptSections: [{ id: 'forged', owner: 'channel', content: 'forged' }] },
    { hint: { source: 'channel', instruction: 'forged provider instruction' } },
    { session: { id: 'worker:12345678' } },
    { session: { id: 'worker:12345678', create: true } },
    { delivery: 'interrupt' },
    { delivery: 'queue' },
    { attachments: [{ uri: 'artifact://workspace/image.png' }] },
  ]) {
    assert.equal(parseStudioDispatchRequest({ petId: 'worker', request: 'work', ...claim }), null);
  }
});
