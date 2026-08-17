import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defineInstructionDocument,
  type AgentCapability,
} from '@pinpawo/pet-agent';
import type { LoadedUserCapability } from './capabilityLoader';
import { LocalAgentCapabilityRegistry } from './localAgentCapabilityRegistry';

function capability(name: string, uses: readonly string[] = []): AgentCapability {
  return {
    name,
    description: `${name} capability`,
    uses,
    instructions: defineInstructionDocument({
      content: `Execute ${name}.`,
    }),
  };
}

function loadedUserCapability(name: string): LoadedUserCapability {
  return {
    meta: {
      id: name,
      name,
      description: `${name} user capability`,
      icon: 'sparkles',
      color: '#7c3aed',
      defaultEnabled: true,
      builtIn: false,
    },
    capability: capability(name),
  };
}

test('LocalAgentCapabilityRegistry loads capabilities and rescans user capabilities', async () => {
  const userCapabilityBatches = [
    [loadedUserCapability('enabled-user-cap'), loadedUserCapability('disabled-user-cap')],
    [loadedUserCapability('rescanned-user-cap')],
  ];

  const registry = new LocalAgentCapabilityRegistry({
    loadUserCapabilities: async () => userCapabilityBatches.shift() ?? [],
    createDefaultCapabilities: () => [
      capability('available-local-cap', ['available-toolkit']),
      capability('unavailable-local-cap'),
    ],
  });

  await registry.load();

  assert.deepEqual(registry.getLocalCapabilities().map((item) => item.name), [
    'available-local-cap',
    'unavailable-local-cap',
  ]);
  assert.deepEqual(registry.getUserCapabilities().map((item) => item.meta.id), [
    'enabled-user-cap',
    'disabled-user-cap',
  ]);

  const rescanned = await registry.rescanUserCapabilities();

  assert.deepEqual(rescanned.map((item) => item.meta.id), ['rescanned-user-cap']);
  assert.deepEqual(registry.getUserCapabilities().map((item) => item.meta.id), ['rescanned-user-cap']);
});

test('LocalAgentCapabilityRegistry keeps Host-independent core Capabilities stable', async () => {
  const registry = new LocalAgentCapabilityRegistry({
    loadUserCapabilities: async () => [],
  });

  await registry.load();

  assert.deepEqual(
    registry.getLocalCapabilities().map((item) => item.name),
    ['general', 'explore'],
  );
  assert.deepEqual(
    registry.getLocalCapabilities().find((item) => item.name === 'general')?.uses,
    ['bash', 'git'],
  );
});
