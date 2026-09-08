import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Studio } from '../studioContract';
import {
  defineInstructionDocument,
  type AgentCapability,
} from '@pinpawo/pet-agent';
import {
  buildLocalAgentRuntimeConfig,
  loadCapabilityDirectory,
  type HostCapabilityAssembly,
  type HostCapabilityAssemblyInitOptions,
} from 'pinpawo/host-runtime';
import { StudioHost } from './StudioHost';
import type { BuildStudioResult, ResolvedStudioHostConfig } from './buildStudio';

function fakeStudio(onShutdown: () => void): Studio {
  return {
    entryPetId: 'pet-a',
    dispatch: async () => ({
      petId: 'pet-1',
      invocationId: 'invocation-1',
    }),
    notify: () => {},
    subscribe: () => () => {},
    listPets: () => [],
    shutdown: async () => { onShutdown(); },
  };
}

function fakeCapabilityAssembly(
  events: string[],
  options: {
    failInit?: boolean;
    onInit?: (input: HostCapabilityAssemblyInitOptions) => void;
  } = {},
): HostCapabilityAssembly {
  const runtimeConfig = buildLocalAgentRuntimeConfig('/tmp/pinpawo-studio-host-test');
  const hostCapabilities = [agentCapability('general')];
  let initialized = false;
  const capabilityCatalog = {
    getSnapshot: () => ({ capabilities: hostCapabilities }),
    createDirectorySnapshot: async ({ rootDir }: { rootDir: string }) => {
      if (!initialized) {
        throw new Error('Pet capability snapshots require an initialized Host catalog');
      }
      const loaded = await loadCapabilityDirectory(rootDir);
      return {
        capabilities: [
          ...hostCapabilities,
          ...loaded.map(({ capability }) => capability),
        ],
      };
    },
  };
  return {
    acquireWriterLease: () => undefined,
    init: async (input = {}) => {
      events.push('caps:init');
      options.onInit?.(input);
      if (options.failInit) throw new Error('caps init failed');
      initialized = true;
    },
    shutdown: async () => { events.push('caps:shutdown'); },
    getExecutionConfig: () => ({runtimeConfig, globalReviewPolicyMode: 'require_authorization' as const, autoAuthorizationSafetyLevel: 'strict' as const, capabilityRegistryBackend: 'memory' as const}),
    getRuntimeConfig: () => runtimeConfig,
    getModelProfiles: () => ({}) as never,
    getCapabilityCatalog: () => capabilityCatalog,
    getToolkitInventoryStore: () => ({
      getSnapshot: () => ({ effectiveToolkits: [] }),
    }) as never,
    getToolkitRuntimeManager: () => ({}) as never,
    getCheckpointer: () => ({}) as never,
    getCapabilityArtifactStore: () => ({}) as never,
  } as unknown as HostCapabilityAssembly;
}

function configuration(
  plugins: ResolvedStudioHostConfig['plugins'] = [],
  petIds: string[] = [],
): ResolvedStudioHostConfig {
  return {
    workdir: '/tmp/pinpawo-studio-host-test',
    studioConfigPath: '/tmp/pinpawo-studio-host-test/.pinpawo/studio.json',
    petsDir: '/tmp/pinpawo-studio-host-test/.pinpawo/pets',
    resolved: {
      pets: petIds.map((petId) => ({ petId, name: petId })),
    } as ResolvedStudioHostConfig['resolved'],
    plugins,
  };
}

function result(studio: Studio): BuildStudioResult {
  return {
    studio,
    resolved: {} as BuildStudioResult['resolved'],
    plugins: [],
    residentPets: new Map(),
    activatePlugins: async () => undefined,
  };
}

function agentCapability(name: string): AgentCapability {
  return {
    name,
    description: `${name} Agent Capability.`,
    uses: [],
    instructions: defineInstructionDocument({ content: `# ${name}` }),
  };
}

test('StudioHost owns resident Studio lifecycle and shuts it down before capabilities', async () => {
  const events: string[] = [];
  const studio = fakeStudio(() => { events.push('studio:shutdown'); });
  const host = new StudioHost({
    runtimeConfig: buildLocalAgentRuntimeConfig('/tmp/pinpawo-studio-host-test'),
    capabilityAssembly: fakeCapabilityAssembly(events),
    resolveStudioHostConfig: async () => configuration(),
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
    resolveStudioHostConfig: async () => configuration(),
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

test('StudioHost releases early writer ownership when configuration resolution fails', async () => {
  const events: string[] = [];
  const assembly = fakeCapabilityAssembly(events);
  assembly.acquireWriterLease = () => { events.push('caps:lease'); };
  const host = new StudioHost({
    capabilityAssembly: assembly,
    resolveStudioHostConfig: async () => {
      throw new Error('configuration failed');
    },
    buildStudio: async () => assert.fail('Studio must not build'),
  });

  await assert.rejects(() => host.init(), /configuration failed/);
  assert.deepEqual(events, ['caps:lease', 'caps:shutdown']);
});

test('StudioHost rolls back a partially initialized capability assembly', async () => {
  const events: string[] = [];
  const host = new StudioHost({
    runtimeConfig: buildLocalAgentRuntimeConfig('/tmp/pinpawo-studio-host-test'),
    capabilityAssembly: fakeCapabilityAssembly(events, { failInit: true }),
    resolveStudioHostConfig: async () => configuration(),
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
    resolveStudioHostConfig: async () => configuration(),
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

test('StudioHost supplies Plugin Toolkits to the Host inventory before building Studio', async () => {
  const events: string[] = [];
  const toolkit = {
    name: 'plugin-tools',
    description: 'Plugin-defined Agent Toolkit.',
    tools: [],
  };
  let sources: HostCapabilityAssemblyInitOptions['toolkitSources'];
  const assembly = fakeCapabilityAssembly(events, {
    onInit: (input) => { sources = input.toolkitSources; },
  });
  assembly.getToolkitInventoryStore = () => ({
    getSnapshot: () => ({ effectiveToolkits: [toolkit] }),
  }) as never;
  const host = new StudioHost({
    capabilityAssembly: assembly,
    resolveStudioHostConfig: async () => configuration([{
      name: 'layout',
      toolkits: [toolkit],
      start: () => undefined,
    }]),
    buildStudio: async (input) => {
      events.push('studio:build');
      assert.deepEqual(input.toolkitInventory.getSnapshot().effectiveToolkits, [toolkit]);
      return result(fakeStudio(() => undefined));
    },
  });

  await host.init();
  assert.deepEqual(sources, [{
    id: 'studio-plugin:layout',
    kind: 'plugin',
    definitions: [toolkit],
  }]);
  assert.deepEqual(events, ['caps:init', 'studio:build']);
  await host.shutdown();
});

test('StudioHost loads each Pet Capability collection from its conventional directory', async () => {
  const events: string[] = [];
  const general = agentCapability('general');
  const assembly = fakeCapabilityAssembly(events);
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-host-capabilities-'));
  const petsDir = path.join(root, '.pinpawo', 'pets');
  const capabilityDir = path.join(
    petsDir,
    'planner',
    'capabilities',
    'studio-planning',
  );
  await mkdir(capabilityDir, { recursive: true });
  await writeFile(path.join(capabilityDir, 'CAPABILITY.md'), `---
name: studio_planning
description: "Plan work through the Studio board."
uses: []
version: 1
---

# Studio planning

Plan the work assigned to this Pet.
`);
  await writeFile(path.join(petsDir, 'planner', 'PET.md'), '# Planner\n\nCoordinate work.\n');
  const configured = {
    ...configuration([], ['planner']),
    workdir: root,
    studioConfigPath: path.join(root, '.pinpawo', 'studio.json'),
    petsDir,
  };
  const host = new StudioHost({
    capabilityAssembly: assembly,
    resolveStudioHostConfig: async () => configured,
    buildStudio: async (input) => {
      assert.deepEqual(input.hostCapabilities, [general]);
      assert.deepEqual(
        input.petCapabilities.get('planner')?.map(({ name }) => name),
        ['studio_planning'],
      );
      assert.equal(input.petDocuments?.get('planner')?.content, '# Planner\n\nCoordinate work.');
      return result(fakeStudio(() => undefined));
    },
  });

  await host.init();
  await host.shutdown();
});

test('StudioHost claims writer ownership before resolving executable extensions', async () => {
  const events: string[] = [];
  const assembly = fakeCapabilityAssembly(events);
  assembly.acquireWriterLease = () => { events.push('caps:lease'); };
  const host = new StudioHost({
    capabilityAssembly: assembly,
    resolveStudioHostConfig: async () => {
      events.push('config:resolve');
      return configuration();
    },
    buildStudio: async () => result(fakeStudio(() => undefined)),
  });

  await host.init();
  assert.deepEqual(events.slice(0, 3), [
    'caps:lease',
    'config:resolve',
    'caps:init',
  ]);
  await host.shutdown();
});
