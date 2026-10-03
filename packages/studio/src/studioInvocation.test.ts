import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStudioDispatchRequest } from './studioInvocation';

test('dispatch parses an explicit domain scope separately from metadata and rejects claimed authors', () => {
  const input = { petId: 'worker', request: 'respond', scope: { namespace: 'channel', id: 'c' }, metadata: { channelId: 'untrusted-correlation' } };
  const parsed = parseStudioDispatchRequest(input);
  assert.deepEqual(parsed, input);
  input.scope.id = 'changed';
  assert.equal(parsed?.scope?.id, 'c');
  for (const scope of [{ id: 'c' }, { namespace: 'channel', id: ' ' }, { namespace: 'channel', id: 'c', author: 'someone' }, ['channel', 'c']]) {
    assert.equal(parseStudioDispatchRequest({ petId: 'worker', request: 'respond', scope }), null);
  }
});
