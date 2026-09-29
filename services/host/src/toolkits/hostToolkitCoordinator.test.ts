import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from '@langchain/core/tools';
import { defineToolkit } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { HostToolkitCoordinator } from './hostToolkitCoordinator';

test('HostToolkitCoordinator owns inventory and availability projection', async () => {
  const warnings: string[] = [];
  const availableToolkit = defineToolkit({
    name: 'fake-available',
    description: 'fake available',
    availability: () => ({ available: true }),
    tools: [{
      tool: tool(async () => 'ok', {
        name: 'fake_tool',
        description: 'fake tool',
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
  });

  const snapshot = await coordinator.initialize([{
    id: 'test-host',
    kind: 'host_builtin',
    definitions: [availableToolkit, unavailableToolkit],
  }]);

  assert.equal(coordinator.getInventoryStore().getSnapshot(), snapshot);
  assert.deepEqual(snapshot.effectiveToolkits, [availableToolkit]);
  assert.deepEqual(warnings, [
    '[toolkits] Toolkit "offline" unavailable '
      + '(host_builtin source "test-host" definition 1): offline for test',
  ]);
});
