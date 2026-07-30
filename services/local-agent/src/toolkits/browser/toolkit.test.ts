import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBrowserAvailabilitySnapshot,
  checkBrowserAvailability,
  getCachedBrowserAvailability,
} from './toolkit';
import type { BrowserBridgeStatus } from './drivers/chromeExtension/bridge';

test('browser availability keeps its host health diagnostics', async () => {
  const availability = await checkBrowserAvailability();

  assert.equal(getCachedBrowserAvailability(), availability);
  assert.equal(typeof availability.available, 'boolean');
  if (availability.metadata) {
    assert.equal(typeof availability.metadata.mode, 'string');
  }
});

test('waiting extension stays routable without claiming command readiness', () => {
  const bridge: BrowserBridgeStatus = {
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
  const availability = buildBrowserAvailabilitySnapshot({
    mode: 'extension',
    configured: 'extension',
    detail: 'native host connected; waiting for extension registration',
    readiness: 'waiting',
    commandReady: false,
  }, bridge);

  assert.equal(availability.available, true);
  assert.equal(availability.reason, undefined);
  assert.equal(availability.metadata?.readiness, 'waiting');
  assert.equal(availability.metadata?.commandReady, false);
  assert.equal(availability.metadata?.hostConnected, true);
});

test('structurally unavailable browser is filtered from the toolkit registry', () => {
  const availability = buildBrowserAvailabilitySnapshot({
    mode: 'none',
    configured: 'playwright',
    detail: 'configured playwright but unavailable',
    readiness: 'unavailable',
    commandReady: false,
  });

  assert.equal(availability.available, false);
  assert.equal(availability.reason, 'configured playwright but unavailable');
  assert.equal(availability.metadata?.commandReady, false);
});
