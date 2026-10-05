import assert from 'node:assert/strict';
import test from 'node:test';

import { createInstalledStudioPluginResolver } from './installedPluginResolver';

test('installed Plugin resolver loads one package and creates independent Plugin instances', async () => {
  const imports: string[] = [];
  const creations: unknown[] = [];
  const resolver = createInstalledStudioPluginResolver({
    workdir: '/workspace',
    importPlugin: async (packageName) => {
      imports.push(packageName);
      return {
        createStudioPlugin: (options: Record<string, unknown> | undefined, environment: unknown) => {
          creations.push({ options, environment });
          return {
            name: `example-${creations.length.toString()}`,
            toolkits: [],
            start: () => undefined,
          };
        },
      };
    },
  });

  assert.equal((await resolver('@example/studio-plugin', { instance: 1 })).name, 'example-1');
  assert.equal((await resolver('@example/studio-plugin', { instance: 2 })).name, 'example-2');
  assert.deepEqual(imports, ['@example/studio-plugin']);
  assert.deepEqual(creations, [
    { options: { instance: 1 }, environment: { workdir: '/workspace' } },
    { options: { instance: 2 }, environment: { workdir: '/workspace' } },
  ]);
});

test('installed Plugin resolver rejects paths and packages without a Plugin factory', async () => {
  const resolver = createInstalledStudioPluginResolver({
    workdir: '/workspace',
    importPlugin: async () => ({}),
  });
  await assert.rejects(async () => resolver('../plugin'), /installed package name/);
  await assert.rejects(async () => resolver('example-plugin'), /createStudioPlugin/);
});

test('a missing configured Plugin reports manual migration guidance and retains the import failure', async () => {
  const cause = new Error('Package is not installed');
  const resolver = createInstalledStudioPluginResolver({
    workdir: '/workspace',
    importPlugin: async () => { throw cause; },
  });
  await assert.rejects(async () => resolver('@example/retired-plugin'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.cause, cause);
    assert.match(error.message, /@example\/retired-plugin/);
    assert.match(error.message, /studio\.json/);
    assert.match(error.message, /update dependent Pet Capabilities and Trigger rules manually/);
    return true;
  });
});
