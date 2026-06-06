import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPluginsFromDir } from './pluginLoader';

test('loadPluginsFromDir loads plugin toolkits and legacy direct tools', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-plugins-'));
  await fs.writeFile(path.join(root, 'valid-plugin.mjs'), `
export const tools = [{ name: 'legacy_tool' }];
export const toolkits = [{
  name: 'sample_toolkit',
  description: 'Sample toolkit',
  tools: [{ name: 'sample_tool' }],
  operations: {
    sample_tool: { kind: 'sample.tool' },
  },
}];
export default { name: 'valid-plugin' };
`, 'utf8');

  const result = await loadPluginsFromDir(root);

  assert.deepEqual(result.plugins.map((plugin) => plugin.name), ['valid-plugin']);
  assert.deepEqual(result.tools.map((tool) => tool.name), ['legacy_tool']);
  assert.deepEqual(result.toolkits.map((toolkit) => toolkit.name), ['sample_toolkit']);
  assert.equal(result.toolkits[0]?.operations?.sample_tool?.kind, 'sample.tool');
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
  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.toolkits, []);
});
