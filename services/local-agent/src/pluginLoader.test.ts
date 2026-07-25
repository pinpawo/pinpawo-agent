import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPluginsFromDir } from './pluginLoader';

test('loadPluginsFromDir loads plugin toolkits and ignores unsupported tools exports', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-plugins-'));
  await fs.writeFile(path.join(root, 'valid-plugin.mjs'), `
export const tools = [{ name: 'legacy_tool' }];
export const toolkits = [{
  name: 'sample_toolkit',
  description: 'Sample toolkit',
  tools: [{
    tool: { name: 'sample_tool' },
    operation: { title: 'Sample Tool' },
  }],
}];
export default { name: 'valid-plugin' };
`, 'utf8');

  const result = await loadPluginsFromDir(root);

  assert.deepEqual(result.plugins.map((plugin) => plugin.name), ['valid-plugin']);
  assert.deepEqual(result.toolkits.map((toolkit) => toolkit.name), ['sample_toolkit']);
  assert.equal(result.toolkits[0]?.tools[0]?.operation?.title, 'Sample Tool');
});

test('loadPluginsFromDir skips tools and toolkits from invalid plugin modules', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-plugins-invalid-'));
  await fs.writeFile(path.join(root, 'invalid-plugin.mjs'), `
export const tools = [{ name: 'leaked_legacy_tool' }];
export const toolkits = [{ name: 'leaked_toolkit', description: 'Leaked toolkit' }];
export default {};
`, 'utf8');

  const result = await loadPluginsFromDir(root);

  assert.deepEqual(result.plugins, []);
  assert.deepEqual(result.toolkits, []);
});

test('loadPluginsFromDir excludes a plugin Toolkit whose availability check fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-plugins-offline-'));
  await fs.writeFile(path.join(root, 'offline-plugin.mjs'), `
export const toolkits = [{
  name: 'offline_toolkit',
  description: 'Offline toolkit',
  tools: [{ tool: { name: 'offline_tool' } }],
  availability: () => ({ available: false, reason: 'service offline' }),
}];
export default { name: 'offline-plugin' };
`, 'utf8');

  const result = await loadPluginsFromDir(root);

  assert.deepEqual(result.plugins.map((plugin) => plugin.name), ['offline-plugin']);
  assert.deepEqual(result.toolkits, []);
});

test('loadPluginsFromDir fails startup for an oversized toolkit auto-review policy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-plugins-policy-'));
  await fs.writeFile(path.join(root, 'invalid-policy-plugin.mjs'), `
export const toolkits = [{
  name: 'invalid_policy_toolkit',
  description: 'Invalid policy toolkit',
  tools: [{ tool: { name: 'sample_tool' } }],
  reviewGuidance: {
    allow: 'x'.repeat(2001),
    ask: 'Ask for risky operations.',
  },
}];
export default { name: 'invalid-policy-plugin' };
`, 'utf8');

  await assert.rejects(
    () => loadPluginsFromDir(root),
    /Toolkit "invalid_policy_toolkit" review guidance allow exceeds 2000 characters/,
  );
});
