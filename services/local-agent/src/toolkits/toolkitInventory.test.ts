import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from '@langchain/core/tools';
import { defineToolkit, type AgentToolkit } from '@pinpawo/pet-agent';
import { z } from 'zod';
import {
  buildHostToolkitInventory,
  HostToolkitInventoryStore,
  reportUnavailableToolkitAvailability,
} from './toolkitInventory';
import { createBashToolkit, createGitToolkit } from './local';
import { createOperationRegistryForLocalServerDeps } from '../runtimeOperationRegistry';
import type { HostToolkitRegistration } from './runtimeBinding';

function toolkit(name: string, available = true): AgentToolkit {
  return defineToolkit({
    name,
    description: `${name} toolkit`,
    availability: () => available
      ? { available: true }
      : { available: false, reason: `${name} offline` },
    tools: [{
      tool: tool(async () => name, {
        name: `${name}_tool`,
        description: `${name} tool`,
        schema: z.object({}),
      }),
    }],
  });
}

function registration(toolkit: AgentToolkit, runtimeKind?: string): HostToolkitRegistration {
  return { toolkit, ...(runtimeKind ? { runtimeKind } : {}) };
}

test('buildHostToolkitInventory preserves source order and provenance', async () => {
  const pluginToolkit = toolkit('plugin');
  const bashToolkit = toolkit('bash');
  const offlineToolkit = toolkit('offline', false);

  const inventory = await buildHostToolkitInventory({
    sources: [
      { id: 'plugin-a', kind: 'plugin', definitions: [registration(pluginToolkit)] },
      {
        id: 'local-agent',
        kind: 'host_builtin',
        definitions: [registration(bashToolkit), registration(offlineToolkit)],
      },
    ],
  });

  assert.deepEqual(inventory.entries.map(({ toolkit }) => toolkit.name), [
    'plugin',
    'bash',
    'offline',
  ]);
  assert.deepEqual(
    inventory.effectiveToolkits.map(({ name }) => name),
    ['plugin', 'bash'],
  );
  assert.deepEqual(inventory.entries.map(({ provenance }) => provenance), [
    {
      sourceId: 'plugin-a',
      sourceKind: 'plugin',
      sourceIndex: 0,
      definitionIndex: 0,
    },
    {
      sourceId: 'local-agent',
      sourceKind: 'host_builtin',
      sourceIndex: 1,
      definitionIndex: 0,
    },
    {
      sourceId: 'local-agent',
      sourceKind: 'host_builtin',
      sourceIndex: 1,
      definitionIndex: 1,
    },
  ]);
  assert.equal(Object.isFrozen(inventory), true);
  assert.equal(Object.isFrozen(inventory.entries), true);
  assert.equal(Object.isFrozen(inventory.entries[0]), true);
  assert.equal(Object.isFrozen(inventory.effectiveToolkits), true);
});

test('buildHostToolkitInventory rejects duplicate names before starting runtimes', async () => {
  let started = false;
  await assert.rejects(
    () => buildHostToolkitInventory({
      sources: [
        { id: 'plugin-a', kind: 'plugin', definitions: [registration(toolkit('shared'))] },
        { id: 'local-agent', kind: 'host_builtin', definitions: [registration(toolkit('shared'))] },
      ],
      assembleToolkits: async registrations => {
        started = true;
        return registrations.map(({ toolkit }) => toolkit);
      },
    }),
    /Duplicate Toolkit name "shared".*plugin source "plugin-a".*host_builtin source "local-agent"/,
  );
  assert.equal(started, false);
});

test('buildHostToolkitInventory rejects duplicate source ids before starting runtimes', async () => {
  let started = false;
  await assert.rejects(
    () => buildHostToolkitInventory({
      sources: [
        { id: 'plugin-a', kind: 'plugin', definitions: [registration(toolkit('one'))] },
        { id: 'plugin-a', kind: 'plugin', definitions: [registration(toolkit('two'))] },
      ],
      assembleToolkits: async registrations => {
        started = true;
        return registrations.map(({ toolkit }) => toolkit);
      },
    }),
    /Duplicate Toolkit definition source id "plugin-a" at indexes 0 and 1/,
  );
  assert.equal(started, false);
});

test('buildHostToolkitInventory starts all definitions before availability evaluation', async () => {
  const events: string[] = [];
  const definitions = [registration(toolkit('plugin')), registration(toolkit('bash'))];
  await buildHostToolkitInventory({
    sources: [{ id: 'all', kind: 'host_builtin', definitions }],
    assembleToolkits: async (registrations) => {
      events.push(`start:${registrations.map(({ toolkit }) => toolkit.name).join(',')}`);
      return registrations.map(({ toolkit }) => toolkit);
    },
    resolveAvailability: async (definition) => {
      events.push(`availability:${definition.name}`);
      return { available: true };
    },
  });

  assert.deepEqual(events, [
    'start:plugin,bash',
    'availability:plugin',
    'availability:bash',
  ]);
});

test('reports unavailable Toolkits uniformly with actionable provenance', async () => {
  const inventory = await buildHostToolkitInventory({
    sources: [
      { id: 'offline-plugin.mjs', kind: 'plugin', definitions: [registration(toolkit('plugin', false))] },
      { id: 'local-agent', kind: 'host_builtin', definitions: [registration(toolkit('bash', false))] },
    ],
  });
  const warnings: string[] = [];

  reportUnavailableToolkitAvailability(inventory, (message) => warnings.push(message));

  assert.deepEqual(warnings, [
    '[toolkits] Toolkit "plugin" unavailable '
      + '(plugin source "offline-plugin.mjs" definition 0): plugin offline',
    '[toolkits] Toolkit "bash" unavailable '
      + '(host_builtin source "local-agent" definition 0): bash offline',
  ]);
});

test('HostToolkitInventoryStore replaces one immutable availability projection', async () => {
  const definition = toolkit('browser', false);
  const before = await buildHostToolkitInventory({
    sources: [{ id: 'local-agent', kind: 'host_builtin', definitions: [registration(definition)] }],
  });
  const inventory = new HostToolkitInventoryStore(before);
  const after = await inventory.refresh(
    'browser',
    async () => ({ available: true }),
  );

  assert.ok(after);
  assert.notEqual(after, before);
  assert.deepEqual(before.effectiveToolkits, []);
  assert.deepEqual(after.effectiveToolkits, [definition]);
  assert.equal(after.entries[0]?.provenance, before.entries[0]?.provenance);
  assert.equal(await inventory.refresh('missing'), null);
});

test('concurrent refreshes merge into the latest Host inventory generation', async () => {
  const first = toolkit('first', false);
  const second = toolkit('second', false);
  const initial = await buildHostToolkitInventory({
    sources: [{ id: 'local-agent', kind: 'host_builtin', definitions: [registration(first), registration(second)] }],
  });
  const inventory = new HostToolkitInventoryStore(initial);
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });

  const firstRefresh = inventory.refresh('first', async () => {
    await firstGate;
    return { available: true };
  });
  const secondRefresh = inventory.refresh('second', async () => {
    await secondGate;
    return { available: true };
  });
  releaseSecond();
  await secondRefresh;
  releaseFirst();
  await firstRefresh;

  assert.deepEqual(
    inventory.getSnapshot().effectiveToolkits.map(({ name }) => name),
    ['first', 'second'],
  );
});

test('an in-flight refresh cannot overwrite a replacement inventory generation', async () => {
  const definition = toolkit('shared', false);
  const initial = await buildHostToolkitInventory({
    sources: [{ id: 'initial', kind: 'host_builtin', definitions: [registration(definition)] }],
  });
  const inventory = new HostToolkitInventoryStore(initial);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const refresh = inventory.refresh('shared', async () => {
    await gate;
    return { available: true };
  });
  const replacement = await buildHostToolkitInventory({
    sources: [{ id: 'replacement', kind: 'host_builtin', definitions: [registration(definition)] }],
    resolveAvailability: async () => ({
      available: false,
      reason: 'replacement generation is offline',
    }),
  });
  inventory.replace(replacement);

  release();
  assert.equal(await refresh, null);
  assert.equal(inventory.getSnapshot(), replacement);
  assert.deepEqual(inventory.getSnapshot().effectiveToolkits, []);
});

test('operation registry derives only from the effective Host inventory', async () => {
  const inventory = await buildHostToolkitInventory({
    sources: [{
      id: 'local-agent',
      kind: 'host_builtin',
      definitions: [registration(createBashToolkit()), registration(createGitToolkit())],
    }],
    resolveAvailability: async (definition) => definition.name === 'bash'
      ? { available: true }
      : { available: false, reason: 'git unavailable' },
  });
  const registry = createOperationRegistryForLocalServerDeps({
    toolkitInventory: new HostToolkitInventoryStore(inventory),
  });

  assert.equal(registry.resolveToolOperation('run_shell')?.source.name, 'bash');
  assert.equal(registry.resolveToolOperation('git_status'), null);
});
