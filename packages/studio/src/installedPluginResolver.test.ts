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
