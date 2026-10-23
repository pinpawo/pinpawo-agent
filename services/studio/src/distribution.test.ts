import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { HostRuntimeConfig } from 'pinpawo/host-runtime';
import { runStudioHostProcess, type StartStudioHostOptions } from './index';

test('complete distribution resolves every Plugin configured by the shipped template', async () => {
  const template = JSON.parse(await readFile(
    new URL('../../../packages/studio/templates/default/studio.json', import.meta.url),
    'utf8',
  )) as { plugins: Array<{ id: string; options?: Record<string, unknown> }> };
  const resolved: string[] = [];
  const previousSecret = process.env.PINPAWO_STUDIO_TRIGGER_SECRET;
  process.env.PINPAWO_STUDIO_TRIGGER_SECRET = 'studio-distribution-test-secret';
  try {
    await runStudioHostProcess({ workdir: '/tmp/studio-distribution-test' }, {
      buildRuntimeConfig: () => ({ workdir: '/tmp/studio-distribution-test' }) as HostRuntimeConfig,
      ensureAuthToken: () => 'test-token',
      signals: new EventEmitter(),
      writeOutput: () => undefined,
      startHost: async (options: StartStudioHostOptions) => {
        for (const { id, options: pluginOptions } of template.plugins) {
          const plugin = await options.resolvePlugin!(id, pluginOptions);
          resolved.push(plugin.name);
        }
        return {
          host: {} as never,
          agentSessionPort: 0,
          close: () => undefined,
          closed: Promise.resolve(),
        };
      },
    });
  } finally {
    if (previousSecret === undefined) delete process.env.PINPAWO_STUDIO_TRIGGER_SECRET;
    else process.env.PINPAWO_STUDIO_TRIGGER_SECRET = previousSecret;
  }
  assert.deepEqual(resolved, ['http', 'notice', 'channel', 'scheduler', 'project-files', 'trigger']);
});
