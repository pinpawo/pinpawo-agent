import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectBrowserStatus,
  selectAutoBrowserBackend,
} from './session';
import {
  projectBrowserRuntimeSnapshot,
  shouldStartBrowserExtensionBridge,
} from './runtime';
import type { BrowserBridgeStatus } from './drivers/chromeExtension/bridge';

function bridgeStatus(
  overrides: Partial<BrowserBridgeStatus> = {},
): BrowserBridgeStatus {
  return {
    listening: false,
    hostConnected: false,
    extensionConnected: false,
    debuggerAttached: false,
    targetAlive: false,
    connectionId: null,
    extensionId: null,
    activeTabId: null,
    activeTabOwnership: null,
    userBoundOrigin: null,
    stateRevision: null,
    capabilities: [],
    socketPath: '/tmp/browser.sock',
    ...overrides,
  };
}

test('auto is extension-first only for operations compatible with the extension driver', () => {
  assert.equal(selectAutoBrowserBackend({
    extensionCommandReady: true,
    playwrightAvailable: true,
  }), 'extension');
  assert.equal(selectAutoBrowserBackend({
    extensionCommandReady: true,
    playwrightAvailable: true,
    requiresPlaywright: true,
  }), 'playwright');
  assert.equal(selectAutoBrowserBackend({
    extensionCommandReady: false,
    playwrightAvailable: true,
  }), 'playwright');
  assert.equal(selectAutoBrowserBackend({
    extensionCommandReady: false,
    playwrightAvailable: false,
    extensionListening: true,
  }), 'extension');
  assert.equal(selectAutoBrowserBackend({
    extensionCommandReady: false,
    playwrightAvailable: false,
    extensionListening: true,
    requiresPlaywright: true,
  }), null);
  assert.equal(selectAutoBrowserBackend({
    extensionCommandReady: false,
    playwrightAvailable: false,
  }), null);
});

test('browser runtime listens for the extension in auto and explicit extension modes', () => {
  assert.equal(shouldStartBrowserExtensionBridge('auto'), true);
  assert.equal(shouldStartBrowserExtensionBridge('extension'), true);
  assert.equal(shouldStartBrowserExtensionBridge('playwright'), false);
});

test('browser runtime snapshot is the canonical live extension projection', () => {
  assert.equal(
    projectBrowserRuntimeSnapshot(bridgeStatus()).extension.state,
    'stopped',
  );
  assert.equal(
    projectBrowserRuntimeSnapshot(bridgeStatus({
      listening: true,
    })).extension.state,
    'listening',
  );
  assert.equal(
    projectBrowserRuntimeSnapshot(bridgeStatus({
      listening: true,
      hostConnected: true,
    })).extension.state,
    'host_connected',
  );

  const snapshot = projectBrowserRuntimeSnapshot(bridgeStatus({
    listening: true,
    hostConnected: true,
    extensionConnected: true,
    connectionId: 'connection-1',
    extensionId: 'extension-1',
    activeTabId: 42,
    activeTabOwnership: 'agent',
    stateRevision: 3,
    capabilities: ['navigate'],
  }));
  assert.deepEqual(snapshot.extension, {
    state: 'ready',
    detail: 'connected extension extension-1',
    bridgeListening: true,
    nativeHostConnected: true,
    extensionRegistered: true,
    commandReady: true,
    debuggerAttached: false,
    targetAlive: false,
    connectionId: 'connection-1',
    extensionId: 'extension-1',
    activeTabId: 42,
    activeTabOwnership: 'agent',
    stateRevision: 3,
    capabilities: ['navigate'],
    socketPath: '/tmp/browser.sock',
  });
});

test('browser runtime snapshot distinguishes native host connectivity from registration', () => {
  const snapshot = projectBrowserRuntimeSnapshot(bridgeStatus({
    listening: true,
    hostConnected: true,
    extensionConnected: false,
  }));

  assert.equal(snapshot.extension.state, 'host_connected');
  assert.equal(
    snapshot.extension.detail,
    'native host connected; waiting for extension registration',
  );
  assert.equal(snapshot.extension.nativeHostConnected, true);
  assert.equal(snapshot.extension.extensionRegistered, false);
  assert.equal(snapshot.extension.commandReady, false);
});

test('browser status consumes the provided runtime snapshot without a second bridge projection', async (t) => {
  const previousBackend = process.env.PINPAWO_BROWSER_BACKEND;
  process.env.PINPAWO_BROWSER_BACKEND = 'extension';
  t.after(() => {
    if (previousBackend === undefined) {
      delete process.env.PINPAWO_BROWSER_BACKEND;
    } else {
      process.env.PINPAWO_BROWSER_BACKEND = previousBackend;
    }
  });

  const status = await detectBrowserStatus(projectBrowserRuntimeSnapshot(bridgeStatus({
    listening: true,
    hostConnected: true,
  })));

  assert.deepEqual(status, {
    mode: 'extension',
    detail: 'native host connected; waiting for extension registration',
    configured: 'extension',
    commandReady: false,
  });
});
