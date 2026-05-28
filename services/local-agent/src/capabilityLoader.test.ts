import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function mkPlugin(root: string, id: string, capabilityName = id) {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id,
    name: `Capability ${id}`,
    description: `Description for ${id}`,
    icon: 'wand.and.stars',
    color: 'purple',
    defaultEnabled: true,
    builtIn: false,
  }), 'utf8');
  await fs.writeFile(path.join(dir, 'index.js'), `
export function createCapability() {
  return {
    name: ${JSON.stringify(capabilityName)},
    description: 'Description for ${id}',
    createRuntime: async () => ({ instructions: ['test'] }),
  };
}
export default createCapability;
`, 'utf8');
  return dir;
}

test('loadUserCapabilities loads valid plugins from configured capability dirs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-'));
  const previousDirs = process.env.PINPAWO_CAPABILITY_DIRS;
  process.env.PINPAWO_CAPABILITY_DIRS = root;
  try {
    await mkPlugin(root, 'unit_test_capability');

    const { loadUserCapabilities, readUserCapabilityManifests } = await import('./capabilityLoader');
    const loaded = await loadUserCapabilities();
    const manifests = readUserCapabilityManifests();

    assert.ok(loaded.some((item) => item.meta.id === 'unit_test_capability'));
    assert.ok(manifests.some((item) => item.id === 'unit_test_capability'));
  } finally {
    if (previousDirs === undefined) {
      delete process.env.PINPAWO_CAPABILITY_DIRS;
    } else {
      process.env.PINPAWO_CAPABILITY_DIRS = previousDirs;
    }
  }
});

test('loadUserCapabilities follows directory symlinks in scan dirs', async () => {
  const scanRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-scan-'));
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-source-'));
  const previousDirs = process.env.PINPAWO_CAPABILITY_DIRS;
  process.env.PINPAWO_CAPABILITY_DIRS = scanRoot;
  try {
    const sourcePluginDir = await mkPlugin(sourceRoot, 'linked_capability');
    await fs.symlink(sourcePluginDir, path.join(scanRoot, 'linked_capability'));

    const { loadUserCapabilities, readUserCapabilityManifests } = await import('./capabilityLoader');
    const loaded = await loadUserCapabilities();
    const manifests = readUserCapabilityManifests();

    assert.ok(loaded.some((item) => item.meta.id === 'linked_capability'));
    assert.ok(manifests.some((item) => item.id === 'linked_capability'));
  } finally {
    if (previousDirs === undefined) {
      delete process.env.PINPAWO_CAPABILITY_DIRS;
    } else {
      process.env.PINPAWO_CAPABILITY_DIRS = previousDirs;
    }
  }
});

test('validateCapabilityPlugin rejects manifest id and runtime name mismatch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-invalid-'));
  const pluginDir = await mkPlugin(root, 'manifest_id', 'runtime_name');

  const { validateCapabilityPlugin } = await import('./capabilityLoader');
  const result = await validateCapabilityPlugin(pluginDir);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /manifest\.id \(manifest_id\) must match capability\.name \(runtime_name\)/);
});
