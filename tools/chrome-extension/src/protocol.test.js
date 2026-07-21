import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPABILITIES, PROTOCOL_VERSION, parseBrowserCommand } from './protocol.js';

test('P1 protocol advertises interaction capabilities at version 2', () => {
  assert.equal(PROTOCOL_VERSION, 2);
  assert.deepEqual(CAPABILITIES, [
    'navigate',
    'snapshot',
    'click',
    'type',
    'scroll',
    'wait',
    'extract',
    'screenshot',
    'detach',
  ]);
  assert.equal(parseBrowserCommand({
    type: 'browser.command',
    protocolVersion: PROTOCOL_VERSION,
    connectionId: 'connection',
    requestId: 'request',
    deadlineAt: new Date(Date.now() + 1_000).toISOString(),
    command: 'click',
    params: { target: { ref: 'snapshot:1' } },
  }).command, 'click');
});
