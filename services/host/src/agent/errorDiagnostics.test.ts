import assert from 'node:assert/strict';
import test from 'node:test';
import { describeAgentError } from './errorDiagnostics';

test('preserves a transport cause without copying request data or messages', () => {
  const cause = Object.assign(new Error('private response'), { name: 'SocketError', code: 'UND_ERR_SOCKET', headers: { authorization: 'private-header' } });
  const error = Object.assign(new TypeError('terminated', { cause }), { status: 502, request: { url: 'https://private.invalid/?token=value' } });
  assert.deepEqual(describeAgentError(error), { chain: [{ name: 'TypeError', status: 502 }, { name: 'SocketError', code: 'UND_ERR_SOCKET' }] });
  assert.doesNotMatch(JSON.stringify(describeAgentError(error)), /private|authorization|https/);
});

test('bounds cyclic and deep causes and ignores unsafe metadata', () => {
  const error = Object.assign(new Error('failure'), { name: 'arbitrary-secret-value', code: 'not a safe code', status: 999, cause: undefined as unknown });
  error.cause = error;
  assert.deepEqual(describeAgentError(error), { chain: [{ name: 'Error' }] });
  let deep: Error = new Error('last');
  for (let i = 0; i < 10; i += 1) deep = new Error('outer', { cause: deep });
  assert.equal(describeAgentError(deep).chain.length, 4);
  assert.deepEqual(describeAgentError('private failure'), { chain: [{ name: 'Error' }] });
});

test('a throwing metadata getter cannot replace the failure being reported', () => {
  const error = Object.defineProperty(new Error('original'), 'cause', { get() { throw new Error('getter'); } });
  assert.deepEqual(describeAgentError(error), { chain: [{ name: 'Error' }] });
});
