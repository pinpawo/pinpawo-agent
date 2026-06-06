import assert from 'node:assert/strict';
import test from 'node:test';
import type { StructuredTool } from '@langchain/core/tools';
import type { AgentCapability, AgentToolkit } from '@pinpawo/pet-agent';
import type { LoadedUserCapability } from './capabilityLoader';
import { LocalAgentCapabilityRegistry } from './localAgentCapabilityRegistry';
import { createBashToolkit, createGitToolkit } from './toolkits/local';
import { createBrowserToolkit } from './toolkits/browser';

function capability(name: string): AgentCapability {
  return {
    name,
    description: `${name} capability`,
    createRuntime: () => ({}),
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

test('LocalAgentCapabilityRegistry loads resources and rescans user capabilities', async () => {
  const localTool = { name: 'local-tool' } as StructuredTool;
  const userCapabilityBatches = [
    [loadedUserCapability('enabled-user-cap'), loadedUserCapability('disabled-user-cap')],
    [loadedUserCapability('rescanned-user-cap')],
  ];
  const availabilityForceValues: Array<boolean | undefined> = [];

  const registry = new LocalAgentCapabilityRegistry({
    loadLocalTools: async () => [localTool],
    loadUserCapabilities: async () => userCapabilityBatches.shift() ?? [],
    createLocalToolkits: (localTools) => [
      {
        name: 'available-toolkit',
        description: 'available toolkit',
        tools: localTools,
      },
      {
        name: 'unavailable-toolkit',
        description: 'unavailable toolkit',
      },
    ],
    createLocalCapabilities: () => [
      capability('available-local-cap'),
      capability('unavailable-local-cap'),
    ],
    resolveAvailableToolkits: async (toolkits: AgentToolkit[]) =>
      toolkits.filter((toolkit) => toolkit.name !== 'unavailable-toolkit'),
    resolveAvailableCapabilities: async (capabilities: AgentCapability[]) =>
      capabilities.filter((item) => item.name !== 'unavailable-local-cap'),
    resolveCapabilityAvailability: async (capabilityItem, options) => {
      availabilityForceValues.push(options?.force);
      return {
        capability: capabilityItem,
        availability: {
          available: capabilityItem.name !== 'disabled-user-cap',
        },
      };
    },
  });

  await registry.load();

  assert.deepEqual(registry.getLocalTools(), [localTool]);
  assert.deepEqual(registry.getLocalToolkitDefinitions().map((item) => item.name), [
    'available-toolkit',
    'unavailable-toolkit',
  ]);
  assert.deepEqual(registry.getLocalToolkits().map((item) => item.name), ['available-toolkit']);
  assert.deepEqual(registry.getLocalCapabilityDefinitions().map((item) => item.name), [
    'available-local-cap',
    'unavailable-local-cap',
  ]);
  assert.deepEqual(registry.getLocalCapabilities().map((item) => item.name), ['available-local-cap']);
  assert.deepEqual(registry.getUserCapabilityDefinitions().map((item) => item.meta.id), [
    'enabled-user-cap',
    'disabled-user-cap',
  ]);
  assert.deepEqual(registry.getUserCapabilities().map((item) => item.meta.id), ['enabled-user-cap']);

  const rescanned = await registry.rescanUserCapabilities();

  assert.deepEqual(rescanned.userCapabilityDefinitions.map((item) => item.meta.id), ['rescanned-user-cap']);
  assert.deepEqual(rescanned.userCapabilities.map((item) => item.meta.id), ['rescanned-user-cap']);
  assert.deepEqual(registry.getUserCapabilities().map((item) => item.meta.id), ['rescanned-user-cap']);
  assert.deepEqual(availabilityForceValues, [undefined, undefined, true]);
});

test('LocalAgentCapabilityRegistry default toolkits include git toolkit', async () => {
  const registry = new LocalAgentCapabilityRegistry({
    loadLocalTools: async () => [],
    loadUserCapabilities: async () => [],
    createLocalToolkits: (localTools) => [
      createBashToolkit(localTools),
      createGitToolkit(),
      createBrowserToolkit(),
    ],
    resolveAvailableToolkits: async (toolkits) => toolkits,
    resolveAvailableCapabilities: async (capabilities) => capabilities,
    resolveCapabilityAvailability: async (capabilityItem) => ({
      capability: capabilityItem,
      availability: { available: true },
    }),
  });

  await registry.load();

  assert.deepEqual(
    registry.getLocalToolkitDefinitions().map((item) => item.name),
    ['bash', 'git', 'browser'],
  );
});
