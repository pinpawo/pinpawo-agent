import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPluginsFromDir } from './pluginLoader';

const langchainToolsModuleUrl = import.meta.resolve('@langchain/core/tools');
const zodModuleUrl = import.meta.resolve('zod');

function toolModulePrelude(): string {
  return `
import { tool } from ${JSON.stringify(langchainToolsModuleUrl)};
import { z } from ${JSON.stringify(zodModuleUrl)};

const defineTestTool = (name) => tool(
  async () => \`\${name} result\`,
  {
    name,
    description: \`\${name} test tool\`,
    schema: z.object({}),
  },
);
`;
}

test('loadPluginsFromDir loads plugin toolkits and ignores unsupported tools exports', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-plugins-'));
  await fs.writeFile(path.join(root, 'valid-plugin.mjs'), `${toolModulePrelude()}
export const tools = [{ name: 'legacy_tool' }];
export const toolkits = [{
  name: 'sample_toolkit',
  description: 'Sample toolkit',
  tools: [{
    tool: defineTestTool('sample_tool'),
    operation: { title: 'Sample Tool' },
  }],
}];
export default { name: 'valid-plugin' };
`, 'utf8');

  const result = await loadPluginsFromDir(root);

  assert.deepEqual(result.plugins.map((plugin) => plugin.name), ['valid-plugin']);
  assert.deepEqual(
    result.toolkitSources.flatMap(({ definitions }) => definitions.map(({ name }) => name)),
    ['sample_toolkit'],
  );
  assert.deepEqual(result.toolkitSources.map(({ id, kind }) => ({ id, kind })), [{
    id: 'valid-plugin.mjs',
    kind: 'plugin',
  }]);
  assert.equal(
    result.toolkitSources[0]?.definitions[0]?.tools[0]?.operation?.title,
    'Sample Tool',
  );
});

test('loadPluginsFromDir uses deterministic plugin files as Toolkit source identities', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-plugins-order-'));
  const pluginModule = (name: string, toolkitName: string) => `${toolModulePrelude()}
export const toolkits = [{
  name: ${JSON.stringify(toolkitName)},
  description: ${JSON.stringify(`${toolkitName} toolkit`)},
  tools: [{ tool: defineTestTool(${JSON.stringify(`${toolkitName}_tool`)}) }],
}];
export default { name: ${JSON.stringify(name)} };
`;
  await fs.writeFile(
    path.join(root, 'z-plugin.mjs'),
    pluginModule('shared-display-name', 'z_toolkit'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'a-plugin.mjs'),
    pluginModule('shared-display-name', 'a_toolkit'),
    'utf8',
  );

  const result = await loadPluginsFromDir(root);

  assert.deepEqual(result.toolkitSources.map(({ id }) => id), [
    'a-plugin.mjs',
    'z-plugin.mjs',
  ]);
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
  assert.deepEqual(result.toolkitSources, []);
});

test('loadPluginsFromDir leaves Toolkit availability to the Host inventory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-plugins-offline-'));
  await fs.writeFile(path.join(root, 'offline-plugin.mjs'), `${toolModulePrelude()}
export const toolkits = [{
  name: 'offline_toolkit',
  description: 'Offline toolkit',
  tools: [{ tool: defineTestTool('offline_tool') }],
  availability: () => ({ available: false, reason: 'service offline' }),
}];
export default { name: 'offline-plugin' };
`, 'utf8');

  const result = await loadPluginsFromDir(root);

  assert.deepEqual(result.plugins.map((plugin) => plugin.name), ['offline-plugin']);
  assert.deepEqual(
    result.toolkitSources.flatMap(({ definitions }) => definitions.map(({ name }) => name)),
    ['offline_toolkit'],
  );
});

test('loadPluginsFromDir fails startup for an oversized toolkit auto-review policy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-plugins-policy-'));
  await fs.writeFile(path.join(root, 'invalid-policy-plugin.mjs'), `${toolModulePrelude()}
export const toolkits = [{
  name: 'invalid_policy_toolkit',
  description: 'Invalid policy toolkit',
  tools: [{ tool: defineTestTool('sample_tool') }],
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
