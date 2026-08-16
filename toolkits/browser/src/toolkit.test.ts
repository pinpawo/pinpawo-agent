import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolkitRuntimeManager } from '@pinpawo/pet-agent';
import {
  buildBrowserAvailabilitySnapshot,
  createBrowserIntegration,
  createBrowserToolkit,
} from './toolkit';

test('only browser_screenshot requires image input', () => {
  const toolkit = createBrowserToolkit();
  const requiringImage = toolkit.tools
    .filter((definition) => definition.requiresInputModalities?.includes('image'))
    .map((definition) => definition.tool.name);

  assert.deepEqual(requiringImage, ['browser_screenshot']);
});

test('browser availability caches only the structural backend decision', async () => {
  const integration = createBrowserIntegration();
  const availability = await integration.checkAvailability();

  assert.equal(integration.getCachedAvailability(), availability);
  assert.equal(typeof availability.available, 'boolean');
  if (availability.metadata) {
    assert.equal(typeof availability.metadata.mode, 'string');
    assert.equal(Object.hasOwn(availability.metadata, 'nativeHostConnected'), false);
    assert.equal(Object.hasOwn(availability.metadata, 'extensionRegistered'), false);
  }
});

test('host configuration disables Browser without reading backend state', async () => {
  let backendReads = 0;
  const integration = createBrowserIntegration({
    enabled: () => false,
    backend: () => {
      backendReads += 1;
      return 'extension';
    },
  });

  const availability = await integration.checkAvailability();

  assert.equal(availability.available, false);
  assert.match(availability.reason ?? '', /disabled by host config/);
  assert.equal(backendReads, 0);
});

test('separate Host managers start independent Browser Runtime roots', async () => {
  const integration = createBrowserIntegration({ backend: () => 'playwright' });
  const managerA = new ToolkitRuntimeManager();
  const managerB = new ToolkitRuntimeManager();

  await managerA.start([integration.toolkit]);
  const runtimeA = integration.runtime;
  await managerB.start([integration.toolkit]);
  const runtimeB = integration.runtime;

  assert.notEqual(runtimeA, runtimeB);
  await managerA.stop();
  assert.equal(integration.runtime, runtimeB);
  await managerB.stop();
  assert.notEqual(integration.runtime, runtimeB);
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
