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
    activeTab: { tabId: 42, binding: 'user' },
    state: {
      revision: 3,
      debuggerAttached: true,
      activeTab: { tabId: 42, binding: 'user' },
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
  assert.deepEqual(message.activeTab, { tabId: 42, binding: 'user' });
  assert.deepEqual(message.state, {
    revision: 3,
    debuggerAttached: true,
    activeTab: { tabId: 42, binding: 'user' },
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
      activeTab: { tabId: 1, binding: 'agent' },
      state: {
        revision: 1,
        debuggerAttached: false,
        activeTab: { tabId: 2, binding: 'agent' },
      },
    }),
    /activeTab must match state\.activeTab/,
  );
});

test('browser extension protocol accepts a user-bound origin only for a user-bound tab', () => {
  const message = parseExtensionToAgentMessage({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    extensionId: 'extension-1',
    capabilities: ['snapshot'],
    state: {
      revision: 1,
      debuggerAttached: false,
      activeTab: { tabId: 42, binding: 'user' },
      userBoundOrigin: 'https://example.com',
    },
  });
  assert.equal(message.type, 'browser.register');
  assert.equal(message.state?.userBoundOrigin, 'https://example.com');

  assert.throws(() => parseExtensionToAgentMessage({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    extensionId: 'extension-1',
    capabilities: ['snapshot'],
    state: {
      revision: 1,
      debuggerAttached: false,
      activeTab: { tabId: 42, binding: 'agent' },
      userBoundOrigin: 'https://example.com',
    },
  }), /requires a user-bound tab/);
  assert.throws(() => parseExtensionToAgentMessage({
    type: 'browser.register',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    extensionId: 'extension-1',
    capabilities: ['snapshot'],
    state: {
      revision: 1,
      debuggerAttached: false,
      activeTab: { tabId: 42, binding: 'user' },
      userBoundOrigin: 'https://example.com/path',
    },
  }), /must be an http\(s\) origin/);
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
  assert.equal(command.type, 'browser.command');
  if (command.type !== 'browser.command') assert.fail('expected browser command');
  assert.equal(command.command, 'snapshot');

  const cancellation = parseAgentToExtensionMessage({
    type: 'browser.cancel',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    requestId: 'request-1',
  });
  assert.deepEqual(cancellation, {
    type: 'browser.cancel',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    requestId: 'request-1',
  });

  const hello = parseBridgeHelloMessage({
    type: 'bridge.hello',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    token: 'secret',
    hostPid: 123,
  });
  assert.equal(hello.token, 'secret');
});

test('browser extension protocol parses new page-lifecycle events and payloads', () => {
  const committed = parseExtensionToAgentMessage({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    event: 'navigation.committed',
    tabId: 42,
    url: 'https://example.com/',
  });
  assert.equal(committed.type, 'browser.event');
  if (committed.type !== 'browser.event') assert.fail('expected browser event');
  assert.equal(committed.event, 'navigation.committed');
  assert.equal(committed.tabId, 42);
  assert.equal(committed.url, 'https://example.com/');

  const dom = parseExtensionToAgentMessage({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    event: 'dom.changed',
    tabId: 42,
    payload: { textLength: 1200, textRevision: 2 },
  });
  if (dom.type !== 'browser.event') assert.fail('expected browser event');
  assert.deepEqual(dom.payload, { textLength: 1200, textRevision: 2 });
});

test('browser extension protocol still parses the legacy tab.navigated event', () => {
  const legacy = parseExtensionToAgentMessage({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    event: 'tab.navigated',
    tabId: 7,
    url: 'https://example.com/',
  });
  assert.equal(legacy.type, 'browser.event');
  if (legacy.type !== 'browser.event') assert.fail('expected browser event');
  assert.equal(legacy.event, 'tab.navigated');
});

test('browser extension protocol preserves opaque browser context ids on events', () => {
  const message = parseExtensionToAgentMessage({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    event: 'document.ready',
    contextId: 'context-opaque-1',
    tabId: 42,
  });

  assert.equal(message.type, 'browser.event');
  assert.equal(message.contextId, 'context-opaque-1');
  assert.throws(() => parseExtensionToAgentMessage({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    event: 'document.ready',
    contextId: '',
  }), /contextId must be a non-empty string/);
});

test('browser extension protocol rejects a malformed event payload', () => {
  assert.throws(() => parseExtensionToAgentMessage({
    type: 'browser.event',
    protocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
    connectionId: 'connection-1',
    event: 'document.ready',
    payload: 'not-an-object',
  }), /payload must be an object/);
});
