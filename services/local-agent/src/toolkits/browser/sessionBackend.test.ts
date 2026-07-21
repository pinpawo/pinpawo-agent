import assert from 'node:assert/strict';
import test from 'node:test';
import { selectAutoBrowserBackend } from './session';
import { shouldStartBrowserExtensionBridge } from './runtime';

test('auto is extension-first only for operations compatible with the extension driver', () => {
  assert.equal(selectAutoBrowserBackend({
    extensionConnected: true,
    playwrightAvailable: true,
  }), 'extension');
  assert.equal(selectAutoBrowserBackend({
    extensionConnected: true,
    playwrightAvailable: true,
    requiresPlaywright: true,
  }), 'playwright');
  assert.equal(selectAutoBrowserBackend({
    extensionConnected: false,
    playwrightAvailable: true,
  }), 'playwright');
  assert.equal(selectAutoBrowserBackend({
    extensionConnected: false,
    playwrightAvailable: false,
    extensionListening: true,
  }), 'extension');
  assert.equal(selectAutoBrowserBackend({
    extensionConnected: false,
    playwrightAvailable: false,
    extensionListening: true,
    requiresPlaywright: true,
  }), null);
  assert.equal(selectAutoBrowserBackend({
    extensionConnected: false,
    playwrightAvailable: false,
  }), null);
});

test('browser runtime listens for the extension in auto and explicit extension modes', () => {
  assert.equal(shouldStartBrowserExtensionBridge('auto'), true);
  assert.equal(shouldStartBrowserExtensionBridge('extension'), true);
  assert.equal(shouldStartBrowserExtensionBridge('playwright'), false);
});
