import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  defineInstructionDocument,
  type AgentCapability,
} from '@pinpawo/pet-agent';
import type { LoadedUserCapability } from './capabilityLoader';
import {
  createHostBaselineCapabilities,
  HostCapabilityCatalog,
} from './hostCapabilityCatalog';

function capability(name: string, uses: readonly string[] = []): AgentCapability {
  return {
    name,
    description: `${name} capability`,
    uses,
    instructions: defineInstructionDocument({ content: `Execute ${name}.` }),
  };
}

function loadedUserCapability(name: string, defaultEnabled = true): LoadedUserCapability {
  return {
    meta: {
      id: name,
      name,
      description: `${name} user capability`,
      icon: 'sparkles',
      color: '#7c3aed',
      defaultEnabled,
      builtIn: false,
    },
    capability: capability(name),
  };
}

test('HostCapabilityCatalog owns source loading and activation', async () => {
  const catalog = new HostCapabilityCatalog({
    loadConfiguredCapabilities: async () => [
      loadedUserCapability('enabled-user-cap'),
      loadedUserCapability('disabled-user-cap', false),
    ],
    createHostCapabilities: () => [capability('host-cap')],
  });

  await catalog.load();
  const initial = catalog.getSnapshot();
  assert.deepEqual(initial.capabilities.map(({ name }) => name), [
    'host-cap',
    'enabled-user-cap',
  ]);

  const overridden = catalog.getSnapshot({
    capabilities: {
      'enabled-user-cap': false,
      'disabled-user-cap': true,
    },
  });
  assert.deepEqual(overridden.capabilities.map(({ name }) => name), [
    'host-cap',
    'disabled-user-cap',
  ]);
});

test('HostCapabilityCatalog lets an explicit directory use the same baseline and registry contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-host-capability-catalog-'));
  const petCapability = join(root, 'pet-capability');
  await mkdir(petCapability);
  await writeFile(join(petCapability, 'CAPABILITY.md'), '---\nname: pet_capability\ndescription: "Pet-only definition"\nuses: []\nversion: 1\ndefaultEnabled: false\n---\n\n# Pet capability\n', 'utf8');
  const catalog = new HostCapabilityCatalog({
    loadConfiguredCapabilities: async () => [],
    createHostCapabilities: createHostBaselineCapabilities,
  });
  await catalog.load();

  const snapshot = await catalog.createDirectorySnapshot({
    rootDir: root,
    sourceId: 'studio-pet:planner',
  });
  assert.deepEqual(snapshot.capabilities.map(({ name }) => name), [
    'general',
    'pet_capability',
  ]);
});

test('HostCapabilityCatalog rejects source definitions that collide with Host names', async () => {
  const catalog = new HostCapabilityCatalog({
    loadConfiguredCapabilities: async () => [loadedUserCapability('explore')],
    createHostCapabilities: createHostBaselineCapabilities,
  });

  await assert.rejects(() => catalog.load(), /explore.*conflicts with host:host/);
});

test('HostCapabilityCatalog rejects a Pet directory that shadows its required baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-host-capability-shadow-'));
  const general = join(root, 'general');
  await mkdir(general);
  await writeFile(
    join(general, 'CAPABILITY.md'),
    '---\nname: general\ndescription: "Shadow baseline"\nuses: []\nversion: 1\ndefaultEnabled: true\n---\n\n# Shadow\n',
    'utf8',
  );
  const catalog = new HostCapabilityCatalog({
    loadConfiguredCapabilities: async () => [],
    createHostCapabilities: createHostBaselineCapabilities,
  });
  await catalog.load();

  await assert.rejects(
    () => catalog.createDirectorySnapshot({
      rootDir: root,
      sourceId: 'studio-pet:planner',
    }),
    /general.*conflicts with host:host/,
  );
});
