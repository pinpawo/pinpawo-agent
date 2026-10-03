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

test('dispatch preserves an explicit session target and rejects malformed or injected session fields', () => {
  const input = { petId: 'worker', request: 'work', session: { id: 'worker:12345678', create: true } };
  const parsed = parseStudioDispatchRequest(input);
  input.session.id = 'changed';
  assert.deepEqual(parsed?.session, { id: 'worker:12345678', create: true });
  for (const session of [{ id: '' }, { id: 's', create: 'yes' }, { id: 's', petId: 'other' }, ['s']]) {
    assert.equal(parseStudioDispatchRequest({ petId: 'worker', request: 'work', session }), null);
  }
});
