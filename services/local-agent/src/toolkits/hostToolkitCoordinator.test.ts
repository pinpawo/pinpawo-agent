import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from '@langchain/core/tools';
import { defineToolkit } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { HostToolkitCoordinator } from './hostToolkitCoordinator';

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
    runtime: 'fake',
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
    connectRuntimes: async ({ toolkits }) => {
      events.push('connect');
      assert.deepEqual(toolkits, [runtimeToolkit, unavailableToolkit]);
      return {
        bindings: {
          'fake-runtime': {
            runtimeType: 'fake', client: { provider: 'fake' },
            identity: { clientId: 'host', instanceId: 'environment' },
            diagnose: () => ({ provider: 'fake' }),
          },
        },
        close: async () => { events.push('disconnect'); },
      };
    },
  });

  const snapshot = await coordinator.initialize([{
    id: 'test-host',
    kind: 'host_builtin',
    definitions: [runtimeToolkit, unavailableToolkit],
  }]);

  assert.equal(coordinator.getInventoryStore().getSnapshot(), snapshot);
  assert.deepEqual(snapshot.effectiveToolkits, [runtimeToolkit]);
  assert.deepEqual(events, ['connect']);
  assert.deepEqual(await coordinator.diagnose(), [{
    toolkitName: 'fake-runtime',
    runtimeType: 'fake',
    identity: { clientId: 'host', instanceId: 'environment' },
    details: { provider: 'fake' },
  }]);
  assert.deepEqual(warnings, [
    '[toolkits] Toolkit "offline" unavailable '
      + '(host_builtin source "test-host" definition 1): offline for test',
  ]);

  await coordinator.shutdown();
  assert.deepEqual(events, ['connect', 'disconnect']);
  assert.deepEqual(await coordinator.diagnose(), []);
  await coordinator.shutdown();
  assert.deepEqual(events, ['connect', 'disconnect']);
});
