import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLocalAgentRuntimeConfig,
  type HostCapabilityAssembly,
} from 'pinpawo/host-runtime';
import type { Studio } from './studioContract';
import type { BuildStudioResult, ResolvedStudioHostConfig } from './host/buildStudio';
import { startStudioHost } from './startStudioHost';

function fakeAssembly(events: string[]): HostCapabilityAssembly {
  const runtimeConfig = buildLocalAgentRuntimeConfig('/tmp/pinpawo-start-studio-host-test');
  return {
    acquireWriterLease: () => undefined,
    init: async () => { events.push('caps:init'); },
    shutdown: async () => { events.push('caps:shutdown'); },
    getRuntimeConfig: () => runtimeConfig,
    getModelProfiles: () => ({}) as never,
    getCapabilityCatalog: () => ({
      getSnapshot: () => ({ capabilities: [{ name: 'general' }] }),
      createDirectorySnapshot: async () => ({ capabilities: [{ name: 'general' }] }),
    }),
    getToolkitInventoryStore: () => ({
      getSnapshot: () => ({ effectiveToolkits: [] }),
    }) as never,
    getToolkitRuntimeManager: () => ({}) as never,
    getCheckpointer: () => ({}) as never,
    getCapabilityArtifactStore: () => ({}) as never,
  } as unknown as HostCapabilityAssembly;
}

function fakeStudio(events: string[]): Studio {
  return {
    entryPetId: 'planner',
    dispatch: async () => ({
      petId: 'planner',
      invocationId: 'invocation-1',
      onInvocation: () => () => undefined,
      completion: Promise.resolve({
        petId: 'planner',
        invocationId: 'invocation-1',
        status: 'completed',
      }),
    }),
    onInvocation: () => () => undefined,
    notify: () => undefined,
    subscribe: () => () => undefined,
    listPets: () => [],
    shutdown: async () => { events.push('studio:shutdown'); },
  };
}

function configuration(): ResolvedStudioHostConfig {
  return {
    workdir: '/tmp/pinpawo-start-studio-host-test',
    studioConfigPath: '/tmp/pinpawo-start-studio-host-test/.pinpawo/studio.json',
    petsDir: '/tmp/pinpawo-start-studio-host-test/.pinpawo/pets',
    resolved: {
      pets: [{ petId: 'planner', name: 'Planner' }],
    } as ResolvedStudioHostConfig['resolved'],
    plugins: [],
  };
}

test('top-level entry starts only the Pet Agent Session transport and owns shutdown', async () => {
  const events: string[] = [];
  let closeTransport!: () => void;
  const transportClosed = new Promise<void>((resolve) => { closeTransport = resolve; });
  const running = await startStudioHost({
    capabilityAssembly: fakeAssembly(events),
    resolveStudioHostConfig: async () => configuration(),
    buildStudio: async (): Promise<BuildStudioResult> => ({
      studio: fakeStudio(events),
      resolved: {} as BuildStudioResult['resolved'],
      plugins: [],
      residentPets: new Map(),
    }),
    agentSessionPort: 0,
    startAgentSessionTransport: async (port, interactions) => {
      events.push('agent-session:start');
      assert.equal(port, 0);
      assert.equal(interactions.size, 0);
      return {
        port: 43123,
        close: closeTransport,
        closed: transportClosed,
      };
    },
  });

  assert.equal(running.agentSessionPort, 43123);
  running.close();
  await running.closed;
  assert.deepEqual(events, [
    'caps:init',
    'agent-session:start',
    'studio:shutdown',
    'caps:shutdown',
  ]);
});

test('Agent Session startup failure rolls the initialized Host back', async () => {
  const events: string[] = [];
  await assert.rejects(() => startStudioHost({
    capabilityAssembly: fakeAssembly(events),
    resolveStudioHostConfig: async () => configuration(),
    buildStudio: async (): Promise<BuildStudioResult> => ({
      studio: fakeStudio(events),
      resolved: {} as BuildStudioResult['resolved'],
      plugins: [],
      residentPets: new Map(),
    }),
    startAgentSessionTransport: async () => {
      throw new Error('listener failed');
    },
  }), /listener failed/);

  assert.deepEqual(events, [
    'caps:init',
    'studio:shutdown',
    'caps:shutdown',
  ]);
});
