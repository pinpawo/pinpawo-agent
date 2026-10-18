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
  assert.deepEqual(describeAgentError(deep), { chain: [{ name: 'Error' }] });
  let named: Error = Object.assign(new Error('root'), { name: 'SocketError', code: 'UND_ERR_SOCKET' });
  for (const name of ['AbortError', 'FetchError', 'HttpError', 'RetryError']) {
    named = Object.assign(new Error('outer', { cause: named }), { name });
  }
  assert.deepEqual(describeAgentError(named).chain.map((item) => item.name), ['RetryError', 'HttpError', 'FetchError', 'SocketError']);
  assert.deepEqual(describeAgentError('private failure'), { chain: [{ name: 'Error' }] });
});

test('a throwing metadata getter cannot replace the failure being reported', () => {
  const error = Object.defineProperty(new Error('original'), 'cause', { get() { throw new Error('getter'); } });
  assert.deepEqual(describeAgentError(error), { chain: [{ name: 'Error' }] });
});

test('wrappers that repeat their cause collapse so the root stays visible', () => {
  let error: Error = Object.assign(new Error('Request timed out.'), { name: 'TimeoutError' });
  for (let i = 0; i < 5; i += 1) error = Object.assign(new Error('Request timed out.', { cause: error }), { name: 'TimeoutError' });
  assert.deepEqual(describeAgentError(error), { chain: [{ name: 'TimeoutError' }] });
  const root = Object.assign(new Error('socket'), { name: 'SocketError', code: 'UND_ERR_SOCKET' });
  let wrapped: Error = root;
  for (let i = 0; i < 6; i += 1) wrapped = Object.assign(new Error('terminated', { cause: wrapped }), { name: 'TypeError' });
  assert.deepEqual(describeAgentError(wrapped), { chain: [{ name: 'TypeError' }, { name: 'SocketError', code: 'UND_ERR_SOCKET' }] });
});
