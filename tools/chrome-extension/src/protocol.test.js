import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  errorResult,
  parseBrowserCancel,
  parseBrowserCommand,
} from './protocol.js';

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
  assert.equal(parseBrowserCancel({
    type: 'browser.cancel',
    protocolVersion: PROTOCOL_VERSION,
    connectionId: 'connection',
    requestId: 'request',
  }).requestId, 'request');
});

test('extension errors preserve structured recovery details', () => {
  const command = {
    connectionId: 'connection',
    requestId: 'request',
  };
  const error = Object.assign(new Error('Origin changed'), {
    code: 'origin_changed',
    retryable: false,
    details: {
      approvedOrigin: 'https://example.com',
      actualOrigin: 'https://login.example.com',
      manualActionRequired: true,
      recovery: 'complete_popup_manually',
      interactionDispatched: true,
    },
  });

  assert.deepEqual(errorResult(command, error).error, {
    code: 'origin_changed',
    message: 'Origin changed',
    retryable: false,
    details: {
      approvedOrigin: 'https://example.com',
      actualOrigin: 'https://login.example.com',
      manualActionRequired: true,
      recovery: 'complete_popup_manually',
      interactionDispatched: true,
    },
  });
});
