import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentClientMessage, parseAgentServerMessage } from './protocol';

test('artifact display address requests and results round trip separately from timeline events', () => {
  const request = { type: 'artifact.address.get', requestId: 'read-1', uri: 'artifact://workspace/session/id/report.txt' };
  const result = { type: 'artifact.address.result', requestId: request.requestId, uri: request.uri,
    address: 'https://objects.example/report?signature=ephemeral', expiresAt: '2026-11-03T13:30:00.000Z' };
  assert.deepEqual(parseAgentClientMessage(JSON.stringify(request)), request);
  assert.deepEqual(parseAgentServerMessage(JSON.stringify(result)), result);
  assert.equal(parseAgentClientMessage({ ...request, token: 'never' }), null);
  assert.equal(parseAgentServerMessage({ ...result, expiresAt: 'invalid' }), null);
  assert.equal(parseAgentServerMessage({ ...result, address: '' }), null);
  assert.equal(parseAgentServerMessage({ ...result, token: 'never' }), null);
});
