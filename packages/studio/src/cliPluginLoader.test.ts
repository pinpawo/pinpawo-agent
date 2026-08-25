import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStudioCliPluginResolver } from './cliPluginLoader';

function plugin(name: string) {
  return { name, toolkits: [], start: () => undefined };
}

test('CLI Plugin loader caches a configured package but creates each Plugin instance', async () => {
  let loads = 0;
  const factoryCalls: Array<{ options: unknown; workdir: string }> = [];
  const resolver = createStudioCliPluginResolver({
    workdir: '/tmp/studio-workdir',
    loadModule: async (specifier) => {
      loads += 1;
      assert.equal(specifier, '@scope/example-plugin');
      return {
        id: 'example',
        createStudioPlugin: (options: Record<string, unknown> | undefined, environment: { workdir: string }) => {
          factoryCalls.push({ options, workdir: environment.workdir });
          return plugin(`example-${String(options?.instance)}`);
        },
      };
    },
  });

  const morning = await resolver('example', { instance: 'morning' }, '@scope/example-plugin');
  const evening = await resolver('example', { instance: 'evening' }, '@scope/example-plugin');

  assert.equal(loads, 1);
  assert.deepEqual(factoryCalls, [
    { options: { instance: 'morning' }, workdir: '/tmp/studio-workdir' },
    { options: { instance: 'evening' }, workdir: '/tmp/studio-workdir' },
  ]);
  assert.equal(morning.name, 'example-morning');
  assert.equal(evening.name, 'example-evening');
});

test('CLI Plugin loader rejects missing, filesystem, and mismatched module locators', async () => {
  const resolver = createStudioCliPluginResolver({
    workdir: '/tmp/studio-workdir',
    loadModule: async () => ({ id: 'other', createStudioPlugin: () => plugin('other') }),
  });

  await assert.rejects(async () => await resolver('example'), /must declare a package "module"/);
  await assert.rejects(
    async () => await resolver('example', undefined, '../plugin.mjs'),
    /package specifier/,
  );
  await assert.rejects(
    async () => await resolver('example', undefined, '@scope/example-plugin'),
    /exports id "other"/,
  );
});

test('CLI Plugin loader requires the configured factory export and a Plugin object result', async () => {
  const noFactory = createStudioCliPluginResolver({
    workdir: '/tmp/studio-workdir',
    loadModule: async () => ({ id: 'example' }),
  });
  await assert.rejects(
    async () => await noFactory('example', undefined, '@scope/example-plugin'),
    /must export createStudioPlugin/,
  );

  const noPlugin = createStudioCliPluginResolver({
    workdir: '/tmp/studio-workdir',
    loadModule: async () => ({ id: 'example', createStudioPlugin: () => undefined }),
  });
  await assert.rejects(
    async () => await noPlugin('example', undefined, '@scope/example-plugin'),
    /must return a StudioPlugin object/,
  );
});
