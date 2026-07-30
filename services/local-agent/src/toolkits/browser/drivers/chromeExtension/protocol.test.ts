import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_EXTENSION_PROTOCOL_VERSION,
  parseAgentToExtensionMessage,
  parseBridgeHelloMessage,
  parseExtensionToAgentMessage,
} from './protocol';

test('browser extension protocol validates register and deduplicates capabilities', () => {
  const message = parseExtensionToAgentMessage({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    extensionId: 'extension-1',
    capabilities: ['navigate', 'snapshot', 'click', 'type', 'scroll', 'extract', 'screenshot', 'snapshot', 'detach'],
    activeTab: { tabId: 42, ownership: 'user' },
    state: {
      revision: 3,
      debuggerAttached: true,
      activeTab: { tabId: 42, ownership: 'user' },
    },
  });

  assert.equal(message.type, 'browser.register');
  assert.deepEqual(message.capabilities, [
    'navigate',
    'snapshot',
    'click',
    'type',
    'scroll',
    'extract',
    'screenshot',
    'detach',
  ]);
  assert.deepEqual(message.activeTab, { tabId: 42, ownership: 'user' });
  assert.deepEqual(message.state, {
    revision: 3,
    debuggerAttached: true,
    activeTab: { tabId: 42, ownership: 'user' },
  });
});

test('browser extension protocol rejects mismatched versions and malformed results', () => {
  assert.throws(
    () => parseExtensionToAgentMessage({
      type: 'browser.register',
      protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION + 1,
      connectionId: 'connection-1',
      extensionId: 'extension-1',
      capabilities: [],
    }),
    /unsupported browser extension protocol version/,
  );

  assert.throws(
    () => parseExtensionToAgentMessage({
      type: 'browser.result',
      protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
      connectionId: 'connection-1',
      requestId: 'request-1',
      ok: false,
    }),
    /failed browser.result must include error/,
  );

  assert.throws(
    () => parseExtensionToAgentMessage({
      type: 'browser.register',
      protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
      connectionId: 'connection-1',
      extensionId: 'extension-1',
      capabilities: [],
      state: {
        revision: -1,
        debuggerAttached: false,
      },
    }),
    /state\.revision must be a non-negative safe integer/,
  );

  assert.throws(
    () => parseExtensionToAgentMessage({
      type: 'browser.register',
      protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
      connectionId: 'connection-1',
      extensionId: 'extension-1',
      capabilities: [],
      activeTab: { tabId: 1, ownership: 'agent' },
      state: {
        revision: 1,
        debuggerAttached: false,
        activeTab: { tabId: 2, ownership: 'agent' },
      },
    }),
    /activeTab must match state\.activeTab/,
  );
});

test('browser extension protocol validates structured error details', () => {
  const message = parseExtensionToAgentMessage({
    type: 'browser.result',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    requestId: 'request-1',
    ok: false,
    error: {
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
    },
  });

  assert.equal(message.type, 'browser.result');
  assert.deepEqual(message.error?.details, {
    approvedOrigin: 'https://example.com',
    actualOrigin: 'https://login.example.com',
    manualActionRequired: true,
    recovery: 'complete_popup_manually',
    interactionDispatched: true,
  });
});

test('browser extension protocol validates commands and bridge authentication messages', () => {
  const command = parseAgentToExtensionMessage({
    type: 'browser.command',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    requestId: 'request-1',
    command: 'snapshot',
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    params: { approvedOrigin: 'https://example.com' },
  });
  assert.equal(command.command, 'snapshot');

  const hello = parseBridgeHelloMessage({
    type: 'bridge.hello',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: 'secret',
    hostPid: 123,
  });
  assert.equal(hello.token, 'secret');
});
