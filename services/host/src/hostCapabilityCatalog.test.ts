import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  defineInstructionDocument,
  type AgentCapability,
} from '@pinpawo/pet-agent';
import type { LoadedCapability } from './capabilityLoader';
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

function loadedUserCapability(
  name: string,
  defaultEnabled = true,
  sourceId = `/configured/${name}/CAPABILITY.md`,
): LoadedCapability {
  return {
    activation: {
      id: name,
      defaultEnabled,
    },
    capability: capability(name),
    sourceId,
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

test('HostCapabilityCatalog rejects duplicate configured definitions with source evidence', async () => {
  const catalog = new HostCapabilityCatalog({
    loadConfiguredCapabilities: async () => [
      loadedUserCapability('duplicate', true, '/first/duplicate/CAPABILITY.md'),
      loadedUserCapability('duplicate', true, '/second/duplicate/CAPABILITY.md'),
    ],
    createHostCapabilities: () => [],
  });

  await assert.rejects(
    () => catalog.load(),
    /duplicate.*second\/duplicate\/CAPABILITY\.md.*first\/duplicate\/CAPABILITY\.md/,
  );
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

async function writeCapability(root: string, directory: string, name: string): Promise<void> {
  await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, directory, 'CAPABILITY.md'),
    `---\nname: ${name}\ndescription: Shared definition\nuses: []\nversion: 1\ndefaultEnabled: false\n---\n\n${randomUUID()}\n`);
}

async function sharedCatalogFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-host-shared-capability-'));
  const catalog = new HostCapabilityCatalog({
    loadConfiguredCapabilities: async () => [],
    createHostCapabilities: createHostBaselineCapabilities,
  });
  await catalog.load();
  return { catalog, local: join(root, 'pet'), shared: join(root, 'shared') };
}

test('explicit shared references select names and reuse the same authored definitions across Pets', async () => {
  const { catalog, local, shared } = await sharedCatalogFixture();
  await writeCapability(local, 'own', 'own_work');
  await writeCapability(shared, 'different-folder-name', 'shared_context');
  await writeCapability(shared, 'other', 'other_shared');
  const selected = await catalog.createDirectorySnapshot({
    rootDir: local, sourceId: 'pet:first', shared: { rootDir: shared, names: ['shared_context'] },
  });
  const otherPet = await catalog.createDirectorySnapshot({
    rootDir: join(local, 'missing'), sourceId: 'pet:second', shared: { rootDir: shared, names: ['shared_context'] },
  });
  assert.deepEqual(selected.capabilities.map(({ name }) => name), ['general', 'own_work', 'shared_context']);
  assert.deepEqual(otherPet.capabilities.map(({ name }) => name), ['general', 'shared_context']);
  assert.equal(selected.capabilities[2], otherPet.capabilities[1]);
  assert.equal(selected.capabilities[2]!.document?.filePath, join(shared, 'different-folder-name', 'CAPABILITY.md'));
  assert.deepEqual(catalog.getSnapshot().capabilities.map(({ name }) => name), ['general', 'explore'], 'shared references do not change the Chat catalog');
});

test('unreferenced shared directories are not loaded or implicitly enabled', async () => {
  const { catalog, local, shared } = await sharedCatalogFixture();
  await mkdir(join(shared, 'invalid'), { recursive: true });
  await writeFile(join(shared, 'invalid', 'CAPABILITY.md'), 'invalid');
  for (const choice of [undefined, { rootDir: shared, names: [] }]) {
    const result = await catalog.createDirectorySnapshot({ rootDir: local, sourceId: 'pet:no-shared', shared: choice });
    assert.deepEqual(result.capabilities.map(({ name }) => name), ['general']);
  }
});

test('missing shared references fail with the requested name and Pet source', async () => {
  const { catalog, local, shared } = await sharedCatalogFixture();
  await assert.rejects(catalog.createDirectorySnapshot({
    rootDir: local, sourceId: 'pet:missing', shared: { rootDir: shared, names: ['absent_context'] },
  }), /Shared Capability "absent_context" requested by pet:missing was not found/);
});

test('shared references use the same collision policy as local definitions and Host baselines', async () => {
  const { catalog, local, shared } = await sharedCatalogFixture();
  await writeCapability(local, 'own', 'shared_context');
  await writeCapability(shared, 'context', 'shared_context');
  await writeCapability(shared, 'baseline', 'general');
  await assert.rejects(catalog.createDirectorySnapshot({
    rootDir: local, sourceId: 'pet:conflict', shared: { rootDir: shared, names: ['shared_context'] },
  }), /shared_context.*shared:.*conflicts with directory:pet:conflict/);
  await assert.rejects(catalog.createDirectorySnapshot({
    rootDir: local, sourceId: 'pet:conflict', shared: { rootDir: shared, names: ['general'] },
  }), /general.*shared:.*conflicts with host:host/);
});

test('one catalog generation snapshots shared sources and reload starts a fresh generation', async () => {
  const { catalog, local, shared } = await sharedCatalogFixture();
  await writeCapability(shared, 'context', 'shared_context');
  const options = { rootDir: local, sourceId: 'pet:snapshot', shared: { rootDir: shared, names: ['shared_context'] } };
  const first = await catalog.createDirectorySnapshot(options);
  await writeCapability(shared, 'context', 'shared_context');
  const sameGeneration = await catalog.createDirectorySnapshot(options);
  assert.equal(sameGeneration.capabilities[1]!.document?.digest, first.capabilities[1]!.document?.digest);
  await catalog.load();
  const reloaded = await catalog.createDirectorySnapshot(options);
  assert.notEqual(reloaded.capabilities[1]!.document?.digest, first.capabilities[1]!.document?.digest);
});
