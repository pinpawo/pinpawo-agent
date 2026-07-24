import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function mkCapability(
  root: string,
  id: string,
  options: { entry?: string; body?: string } = {},
) {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'CAPABILITY.md'), `---
name: ${id}
description: Description for ${id}
uses:
  - bash
version: 1
icon: wand.and.stars
color: purple
defaultEnabled: true
${options.entry ? `entry: ${options.entry}\n` : ''}---

${options.body ?? `# ${id}\n\nExecute the requested task.`}
`, 'utf8');
  return dir;
}

test('loadUserCapabilities loads a code-free CAPABILITY.md', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-'));
  const previousDirs = process.env.PINPAWO_CAPABILITY_DIRS;
  process.env.PINPAWO_CAPABILITY_DIRS = root;
  try {
    await mkCapability(root, 'unit_test_capability');

    const { loadUserCapabilities, readUserCapabilityManifests } = await import('./capabilityLoader');
    const loaded = await loadUserCapabilities();
    const manifests = readUserCapabilityManifests();
    const item = loaded.find(({ meta }) => meta.id === 'unit_test_capability');

    assert.ok(item);
    assert.equal(item.capability.instructions.source.kind, 'file');
    assert.match(item.capability.instructions.content, /Execute the requested task/);
    assert.match(item.capability.instructions.digest, /^[a-f0-9]{64}$/);
    assert.equal(item.capability.lifecycle, undefined);
    assert.ok(manifests.some((meta) => meta.id === 'unit_test_capability'));
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
    const sourceDir = await mkCapability(sourceRoot, 'linked_capability');
    await fs.symlink(sourceDir, path.join(scanRoot, 'linked_capability'));

    const { loadUserCapabilities } = await import('./capabilityLoader');
    const loaded = await loadUserCapabilities();

    assert.ok(loaded.some((item) => item.meta.id === 'linked_capability'));
  } finally {
    if (previousDirs === undefined) {
      delete process.env.PINPAWO_CAPABILITY_DIRS;
    } else {
      process.env.PINPAWO_CAPABILITY_DIRS = previousDirs;
    }
  }
});

test('validateCapabilityPlugin accepts an entry that only exports lifecycle.finalize', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-entry-'));
  const capabilityDir = await mkCapability(root, 'finalized_capability', { entry: './index.js' });
  await fs.writeFile(path.join(capabilityDir, 'index.js'), `
export const lifecycle = {
  finalize(result) {
    return { announceMessageId: result.announceMessageId };
  },
};
`, 'utf8');

  const { validateCapabilityPlugin } = await import('./capabilityLoader');
  const result = await validateCapabilityPlugin(capabilityDir);

  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(typeof result.capability?.lifecycle?.finalize, 'function');
});

test('validateCapabilityPlugin rejects entry paths outside the capability root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-escape-'));
  const capabilityDir = await mkCapability(root, 'escaped_capability', { entry: '../outside.js' });
  await fs.writeFile(path.join(root, 'outside.js'), 'export const lifecycle = { finalize() {} };\n', 'utf8');

  const { validateCapabilityPlugin } = await import('./capabilityLoader');
  const result = await validateCapabilityPlugin(capabilityDir);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /must stay inside/);
});

test('validateCapabilityPlugin rejects broad code exports', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-broad-entry-'));
  const capabilityDir = await mkCapability(root, 'broad_capability', { entry: './index.js' });
  await fs.writeFile(path.join(capabilityDir, 'index.js'), `
export const lifecycle = { finalize() {} };
export function createRuntime() {}
`, 'utf8');

  const { validateCapabilityPlugin } = await import('./capabilityLoader');
  const result = await validateCapabilityPlugin(capabilityDir);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /may only export lifecycle/);
});
