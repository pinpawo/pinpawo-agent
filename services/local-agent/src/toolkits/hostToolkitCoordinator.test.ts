import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from '@langchain/core/tools';
import { defineToolkit } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { HostToolkitCoordinator } from './hostToolkitCoordinator';
import { RuntimeServiceError } from '../runtimeService/protocol';

test('HostToolkitCoordinator connects one client, injects static bindings and closes only its connection', async () => {
  const events: string[] = [];
  const warnings: string[] = [];
  const runtimeToolkit = defineToolkit({
    name: 'fake-runtime',
    description: 'fake runtime',
    availability: () => ({ available: true }),
    tools: [{
      tool: tool(async () => 'ok', {
        name: 'fake_runtime_tool',
        description: 'fake runtime tool',
        schema: z.object({}),
      }),
    }],
  });
  const unavailableToolkit = defineToolkit({
    name: 'offline',
    description: 'offline',
    availability: () => ({ available: false, reason: 'offline for test' }),
    tools: [{
      tool: tool(async () => 'offline', {
        name: 'offline_tool',
        description: 'offline tool',
        schema: z.object({}),
      }),
    }],
  });
  const coordinator = new HostToolkitCoordinator({
    warn: (message) => warnings.push(message),
    connectRuntimes: async ({ requirements }) => {
      events.push('connect');
      assert.deepEqual(requirements, [
        { toolkit: runtimeToolkit, runtimeKind: 'fake' },
        { toolkit: unavailableToolkit },
      ]);
      return {
        bindings: {
          'fake-runtime': {
            runtimeKind: 'fake', client: { provider: 'fake' },
          },
        },
        close: async () => { events.push('disconnect'); },
      };
    },
  });

  const snapshot = await coordinator.initialize([{
    id: 'test-host',
    kind: 'host_builtin',
    definitions: [
      { toolkit: runtimeToolkit, runtimeKind: 'fake' },
      { toolkit: unavailableToolkit },
    ],
  }]);

  assert.equal(coordinator.getInventoryStore().getSnapshot(), snapshot);
  assert.equal(snapshot.effectiveToolkits.length, 1);
  const assembled = snapshot.effectiveToolkits[0];
  assert.equal(assembled.name, runtimeToolkit.name);
  assert.equal('runtime' in assembled, false);
  assert.equal(await assembled.tools[0].tool.invoke({}), 'ok');
  assert.deepEqual(events, ['connect']);
  assert.deepEqual(warnings, [
    '[toolkits] Toolkit "offline" unavailable '
      + '(host_builtin source "test-host" definition 1): offline for test',
  ]);

  await coordinator.shutdown();
  assert.deepEqual(events, ['connect', 'disconnect']);
  await coordinator.shutdown();
  assert.deepEqual(events, ['connect', 'disconnect']);
});

test('a failed Runtime service leaves pure Toolkits available and marks dependent Toolkits unavailable', async () => {
  const runtimeToolkit = defineToolkit({
    name: 'shell', description: 'Needs service',
    tools: [{ tool: tool(async () => 'shell', { name: 'shell_tool', description: 'Shell.', schema: z.object({}) }) }],
  });
  const pureToolkit = defineToolkit({
    name: 'files', description: 'Works in Host',
    tools: [{ tool: tool(async () => 'files', { name: 'files_tool', description: 'Files.', schema: z.object({}) }) }],
  });
  const coordinator = new HostToolkitCoordinator({
    warn: () => {},
    connectRuntimes: async () => { throw new RuntimeServiceError('startup_failed', 'Configuration is invalid.'); },
  });
  const snapshot = await coordinator.initialize([{
    id: 'test-host', kind: 'host_builtin', definitions: [
      { toolkit: runtimeToolkit, runtimeKind: 'shell' }, { toolkit: pureToolkit },
    ],
  }]);
  assert.deepEqual(snapshot.effectiveToolkits.map(({ name }) => name), ['files']);
  assert.equal(snapshot.entries[0]?.availability.available, false);
  assert.equal(await snapshot.effectiveToolkits[0]?.tools[0]?.tool.invoke({}), 'files');
  assert.equal((await coordinator.getInventoryStore().refresh('shell'))?.entries[0]?.availability.available, false);
  await coordinator.shutdown();
});
