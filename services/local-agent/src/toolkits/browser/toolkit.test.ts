import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBrowserAvailabilitySnapshot,
  checkBrowserAvailability,
  getCachedBrowserAvailability,
} from './toolkit';

test('browser availability caches only the structural backend decision', async () => {
  const availability = await checkBrowserAvailability();

  assert.equal(getCachedBrowserAvailability(), availability);
  assert.equal(typeof availability.available, 'boolean');
  if (availability.metadata) {
    assert.equal(typeof availability.metadata.mode, 'string');
    assert.equal(Object.hasOwn(availability.metadata, 'nativeHostConnected'), false);
    assert.equal(Object.hasOwn(availability.metadata, 'extensionRegistered'), false);
  }
});

test('waiting extension stays routable without claiming command readiness', () => {
  const availability = buildBrowserAvailabilitySnapshot({
    mode: 'extension',
    configured: 'extension',
    detail: 'native host connected; waiting for extension registration',
    commandReady: false,
  });

  assert.equal(availability.available, true);
  assert.equal(availability.reason, undefined);
  assert.equal(availability.metadata?.commandReady, false);
});

test('structurally unavailable browser is filtered from the toolkit registry', () => {
  const availability = buildBrowserAvailabilitySnapshot({
    mode: 'none',
    configured: 'playwright',
    detail: 'configured playwright but unavailable',
    commandReady: false,
  });

  assert.equal(availability.available, false);
  assert.equal(availability.reason, 'configured playwright but unavailable');
  assert.equal(availability.metadata?.commandReady, false);
});
