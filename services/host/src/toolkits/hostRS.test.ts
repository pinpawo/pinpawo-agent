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
import { buildHostToolkitInventory, HostToolkitInventoryStore } from './toolkitInventory';

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
        startError = null;
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

  await instances.start({ warn: (message) => warnings.push(message), initialRetryMs: 60_000 });
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

test('an RS that failed to start recovers in the background and its Toolkits come back', async (t) => {
  // Retry timers are unref'd so they never hold a Host open; hold this test open.
  const keepAlive = setInterval(() => undefined, 1_000);
  t.after(() => clearInterval(keepAlive));
  let attempts = 0;
  const instances = new HostRSInstances();
  const flaky = instances.add('flaky', fakeRS('test.rs', {
    start: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('socket busy');
    },
  }));
  const toolkit = instances.assemble(({ env }) => toolkitUsing('uses_flaky', 'env', env), { env: flaky });
  const store = new HostToolkitInventoryStore();

  let recovered!: (names: readonly string[]) => void;
  const recovery = new Promise<readonly string[]>((resolve) => { recovered = resolve; });
  await instances.start({
    warn: () => undefined,
    initialRetryMs: 50,
    // What HostCapabilityAssembly does: re-read the dependents' availability.
    onRecovered: async (names) => {
      for (const name of names) await store.refresh(name);
      recovered(names);
    },
  });
  store.replace(await buildHostToolkitInventory({
    sources: [{ id: 'host', kind: 'host_builtin', definitions: [toolkit] }],
  }));
  assert.deepEqual(store.getSnapshot().effectiveToolkits, []);

  // No tool call reaches the instance; the Host retry alone restores it.
  assert.deepEqual(await recovery, ['uses_flaky']);
  assert.equal(attempts, 2);
  assert.deepEqual(store.getSnapshot().effectiveToolkits.map(({ name }) => name), ['uses_flaky']);
  await instances.dispose();
});

test('dispose cancels pending start retries', async (t) => {
  const keepAlive = setInterval(() => undefined, 1_000);
  t.after(() => clearInterval(keepAlive));
  let attempts = 0;
  const instances = new HostRSInstances();
  instances.add('broken', fakeRS('test.rs', {
    start: async () => {
      attempts += 1;
      throw new Error('down');
    },
  }));
  await instances.start({ warn: () => undefined, initialRetryMs: 5 });
  await instances.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(attempts, 1);
});
