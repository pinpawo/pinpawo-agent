import assert from 'node:assert/strict';
import test from 'node:test';

import type { Studio } from '../studioContract';
import {
  buildLocalAgentRuntimeConfig,
  type HostCapabilityAssembly,
} from 'pinpawo/host-runtime';
import { StudioHost } from './StudioHost';
import type { BuildStudioResult } from './buildStudio';

function fakeStudio(onShutdown: () => void): Studio {
  return {
    entryPetId: 'pet-a',
    dispatch: async () => ({ threadId: 'thread-1' }),
    onDispatchGate: () => () => {},
    notify: () => {},
    subscribe: () => () => {},
    listPets: () => [],
    shutdown: async () => { onShutdown(); },
  };
}

function fakeCapabilityAssembly(
  events: string[],
  options: { failInit?: boolean } = {},
): HostCapabilityAssembly {
  const runtimeConfig = buildLocalAgentRuntimeConfig('/tmp/pinpawo-studio-host-test');
  return {
    init: async () => {
      events.push('caps:init');
      if (options.failInit) throw new Error('caps init failed');
    },
    shutdown: async () => { events.push('caps:shutdown'); },
    getRuntimeConfig: () => runtimeConfig,
    getModelProfiles: () => ({}) as never,
    getLocalCapabilities: () => [],
    getUserCapabilities: () => [],
    getToolkitInventoryStore: () => ({
      getSnapshot: () => ({ effectiveToolkits: [] }),
    }) as never,
    getToolkitRuntimeManager: () => ({}) as never,
    getCheckpointer: () => ({}) as never,
  } as unknown as HostCapabilityAssembly;
}

function result(studio: Studio): BuildStudioResult {
  return {
    studio,
    resolved: {} as BuildStudioResult['resolved'],
    plugins: [],
  };
}

test('StudioHost owns resident Studio lifecycle and shuts it down before capabilities', async () => {
  const events: string[] = [];
  const studio = fakeStudio(() => { events.push('studio:shutdown'); });
  const host = new StudioHost({
    runtimeConfig: buildLocalAgentRuntimeConfig('/tmp/pinpawo-studio-host-test'),
    capabilityAssembly: fakeCapabilityAssembly(events),
    buildStudio: async () => {
      events.push('studio:build');
      return result(studio);
    },
  });

  await host.init();
  assert.equal(host.getStudio(), studio);
  await host.shutdown();

  assert.deepEqual(events, [
    'caps:init',
    'studio:build',
    'studio:shutdown',
    'caps:shutdown',
  ]);
  assert.throws(() => host.getStudio(), /before init/);
});

test('StudioHost rolls back capability assembly when resident Studio build fails', async () => {
  const events: string[] = [];
  const host = new StudioHost({
    runtimeConfig: buildLocalAgentRuntimeConfig('/tmp/pinpawo-studio-host-test'),
    capabilityAssembly: fakeCapabilityAssembly(events),
    buildStudio: async () => {
      events.push('studio:build');
      throw new Error('studio build failed');
    },
  });

  await assert.rejects(() => host.init(), /studio build failed/);
  await host.shutdown();

  assert.deepEqual(events, ['caps:init', 'studio:build', 'caps:shutdown']);
  assert.throws(() => host.getStudio(), /before init/);
});

test('StudioHost rolls back a partially initialized capability assembly', async () => {
  const events: string[] = [];
  const host = new StudioHost({
    runtimeConfig: buildLocalAgentRuntimeConfig('/tmp/pinpawo-studio-host-test'),
    capabilityAssembly: fakeCapabilityAssembly(events, { failInit: true }),
    buildStudio: async () => {
      assert.fail('Studio must not build after capability init fails');
    },
  });

  await assert.rejects(() => host.init(), /caps init failed/);
  assert.deepEqual(events, ['caps:init', 'caps:shutdown']);
});

test('StudioHost serializes concurrent init and shutdown', async () => {
  const events: string[] = [];
  let releaseInit!: () => void;
  const initGate = new Promise<void>((resolve) => { releaseInit = resolve; });
  const assembly = fakeCapabilityAssembly(events);
  assembly.init = async () => {
    events.push('caps:init');
    await initGate;
  };
  const host = new StudioHost({
    capabilityAssembly: assembly,
    buildStudio: async () => {
      events.push('studio:build');
      return result(fakeStudio(() => { events.push('studio:shutdown'); }));
    },
  });

  const initA = host.init();
  const initB = host.init();
  const shutdownA = host.shutdown();
  const shutdownB = host.shutdown();
  releaseInit();
  await Promise.all([initA, initB, shutdownA, shutdownB]);

  assert.deepEqual(events, [
    'caps:init',
    'studio:build',
    'studio:shutdown',
    'caps:shutdown',
  ]);
  await assert.rejects(() => host.init(), /after shutdown started/);
});
