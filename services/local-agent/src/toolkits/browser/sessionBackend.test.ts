import assert from 'node:assert/strict';
import test from 'node:test';
import { selectAutoBrowserBackend } from './session';
import {
  buildBrowserExtensionHealthFields,
  getBrowserExtensionRuntimeState,
  shouldStartBrowserExtensionBridge,
} from './runtime';
import type { BrowserBridgeStatus } from './drivers/chromeExtension/bridge';

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

test('browser extension runtime state distinguishes transport and command readiness', () => {
  assert.equal(getBrowserExtensionRuntimeState({
    listening: false,
    hostConnected: false,
    commandReady: false,
  }), 'stopped');
  assert.equal(getBrowserExtensionRuntimeState({
    listening: true,
    hostConnected: false,
    commandReady: false,
  }), 'listening');
  assert.equal(getBrowserExtensionRuntimeState({
    listening: true,
    hostConnected: true,
    commandReady: false,
  }), 'host_connected');
  assert.equal(getBrowserExtensionRuntimeState({
    listening: true,
    hostConnected: true,
    commandReady: true,
  }), 'ready');
});

test('browser extension health projects live command readiness separately from connectivity', () => {
  const status: BrowserBridgeStatus = {
    listening: true,
    hostConnected: true,
    extensionConnected: false,
    commandReady: false,
    debuggerAttached: false,
    targetAlive: false,
    connectionId: null,
    extensionId: null,
    activeTabId: null,
    activeTabOwnership: null,
    stateRevision: null,
    capabilities: [],
    socketPath: '/tmp/browser.sock',
  };

  assert.deepEqual(buildBrowserExtensionHealthFields(status), {
    browser_detail: 'native host connected; waiting for extension registration',
    browser_runtime_state: 'host_connected',
    browser_host_connected: true,
    browser_extension_connected: false,
    browser_command_ready: false,
    browser_debugger_attached: false,
    browser_target_alive: false,
    browser_active_tab_ownership: null,
    browser_extension_id: null,
    browser_state_revision: null,
  });
});
