import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from '@langchain/core/tools';
import {
  defineToolkit,
  type ToolkitAvailability,
  type ToolkitRS,
} from '@pinpawo/pet-agent';
import { z } from 'zod';
import { assembleToolkit, HostRSInstances, type HostOwnedRS } from './hostRS';
import { buildHostToolkitInventory } from './toolkitInventory';

function fakeRS(contract: string, options: {
  version?: number;
  start?: () => Promise<void>;
  status?: () => ToolkitAvailability;
} = {}): HostOwnedRS & { disposed: boolean } {
  let startError: string | null = null;
  const rs = {
    contract,
    version: options.version ?? 1,
    disposed: false,
    status: () => options.status?.()
      ?? (startError ? { available: false as const, reason: startError } : { available: true as const }),
    ensureSession: () => undefined,
    start: async () => {
      try {
        await options.start?.();
      } catch (error) {
        startError = (error as Error).message;
        throw error;
      }
    },
    dispose: async () => { rs.disposed = true; },
  };
  return rs;
}

function toolkitUsing(name: string, key: string, rs: ToolkitRS) {
  return defineToolkit({
    name,
    description: `${name} toolkit`,
    tools: [{
      tool: tool(async () => 'ok', { name: `${name}_tool`, description: 'tool', schema: z.object({}) }),
    }],
    requires: { [key]: { contract: 'test.rs', version: 1, session: 'agent-session' } },
    availability: async () => await rs.status(),
  });
}

test('assembleToolkit checks injected instances against the declared requirements', () => {
  const rs = fakeRS('test.rs');
  const toolkit = assembleToolkit(({ env }) => toolkitUsing('ok', 'env', env), { env: rs });
  assert.equal(toolkit.name, 'ok');

  assert.throws(
    () => assembleToolkit(({ other }) => toolkitUsing('mismatch', 'env', other), { other: rs }),
    /declares RS dependencies \[env\] but the Host injected \[other\]/,
  );
  assert.throws(
    () => assembleToolkit(({ env }) => toolkitUsing('wrong', 'env', env), { env: fakeRS('other.rs') }),
    /requires env test\.rs@1, but the Host injected other\.rs@1/,
  );
  assert.throws(
    () => assembleToolkit(({ env }) => toolkitUsing('old', 'env', env), { env: fakeRS('test.rs', { version: 2 }) }),
    /requires env test\.rs@1, but the Host injected test\.rs@2/,
  );
});

test('an RS that fails to start makes only the Toolkits built on it unavailable', async () => {
  const warnings: string[] = [];
  const instances = new HostRSInstances();
  const healthy = instances.add('healthy', fakeRS('test.rs'));
  const broken = instances.add('broken', fakeRS('test.rs', {
    start: async () => { throw new Error('bridge socket busy'); },
  }));

  await instances.start((message) => warnings.push(message));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /broken \(test\.rs\) failed to start: bridge socket busy/);

  const inventory = await buildHostToolkitInventory({
    sources: [{
      id: 'host',
      kind: 'host_builtin',
      definitions: [
        assembleToolkit(({ env }) => toolkitUsing('uses_healthy', 'env', env), { env: healthy }),
        assembleToolkit(({ env }) => toolkitUsing('uses_broken', 'env', env), { env: broken }),
      ],
    }],
  });
  assert.deepEqual(inventory.effectiveToolkits.map(({ name }) => name), ['uses_healthy']);
  assert.deepEqual(
    inventory.entries.find(({ toolkit }) => toolkit.name === 'uses_broken')?.availability,
    { available: false, reason: 'bridge socket busy' },
  );

  assert.deepEqual((await instances.status()).map(({ name, availability }) => [name, availability.available]), [
    ['healthy', true],
    ['broken', false],
  ]);

  await instances.dispose();
  assert.equal(healthy.disposed, true);
  assert.equal(broken.disposed, true);
});
