import assert from 'node:assert/strict';
import test from 'node:test';
import { tool, type StructuredTool } from '@langchain/core/tools';
import {
  defineInstructionDocument,
  type AgentCapability,
  type AgentToolkit,
} from '@pinpawo/pet-agent';
import { z } from 'zod';
import type { LoadedUserCapability } from './capabilityLoader';
import { LocalAgentCapabilityRegistry } from './localAgentCapabilityRegistry';
import { createBashToolkit, createGitToolkit } from './toolkits/local';
import { createBrowserToolkit } from '@pinpawo-toolkit/browser';

function mockTool(name: string): StructuredTool {
  return tool(
    async () => `${name} result`,
    {
      name,
      description: `${name} test tool`,
      schema: z.object({}),
    },
  );
}

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

test('LocalAgentCapabilityRegistry loads resources and rescans user capabilities', async () => {
  const localTool = mockTool('local-tool');
  const userCapabilityBatches = [
    [loadedUserCapability('enabled-user-cap'), loadedUserCapability('disabled-user-cap')],
    [loadedUserCapability('rescanned-user-cap')],
  ];

  const registry = new LocalAgentCapabilityRegistry({
    loadLocalTools: async () => [localTool],
    loadUserCapabilities: async () => userCapabilityBatches.shift() ?? [],
    createLocalToolkits: (localTools) => [
      {
        name: 'available-toolkit',
        description: 'available toolkit',
        tools: localTools.map((tool) => ({ tool })),
      },
      {
        name: 'unavailable-toolkit',
        description: 'unavailable toolkit',
        tools: [{ tool: localTool }],
      },
    ],
    createLocalCapabilities: () => [
      capability('available-local-cap', ['available-toolkit']),
      capability('unavailable-local-cap'),
      capability('missing-toolkit-local-cap', ['unavailable-toolkit']),
    ],
    resolveAvailableToolkits: async (toolkits: AgentToolkit[]) =>
      toolkits.filter((toolkit) => toolkit.name !== 'unavailable-toolkit'),
  });

  await registry.load();

  assert.deepEqual(registry.getLocalTools(), [localTool]);
  assert.deepEqual(registry.getLocalToolkitDefinitions().map((item) => item.name), [
    'available-toolkit',
    'unavailable-toolkit',
  ]);
  assert.deepEqual(registry.getLocalToolkits().map((item) => item.name), [
    'available-toolkit',
  ]);
  assert.deepEqual(registry.getLocalCapabilities().map((item) => item.name), [
    'available-local-cap',
    'unavailable-local-cap',
    'missing-toolkit-local-cap',
  ]);
  assert.deepEqual(registry.getUserCapabilities().map((item) => item.meta.id), [
    'enabled-user-cap',
    'disabled-user-cap',
  ]);

  const rescanned = await registry.rescanUserCapabilities();

  assert.deepEqual(rescanned.map((item) => item.meta.id), ['rescanned-user-cap']);
  assert.deepEqual(registry.getUserCapabilities().map((item) => item.meta.id), ['rescanned-user-cap']);
});

test('LocalAgentCapabilityRegistry starts Toolkit runtimes before availability is resolved', async () => {
  const localTool = mockTool('runtime-tool');
  const events: string[] = [];
  const registry = new LocalAgentCapabilityRegistry({
    loadLocalTools: async () => [localTool],
    loadUserCapabilities: async () => [],
    createLocalToolkits: () => [{
      name: 'runtime-toolkit',
      description: 'runtime toolkit',
      tools: [{ tool: localTool }],
    }],
    createLocalCapabilities: () => [],
    resolveAvailableToolkits: async (toolkits) => {
      events.push(`availability:${toolkits.map(({ name }) => name).join(',')}`);
      return toolkits;
    },
  });

  await registry.load({
    startToolkitRuntimes: async (toolkits) => {
      events.push(`start:${toolkits.map(({ name }) => name).join(',')}`);
    },
  });

  assert.deepEqual(events, [
    'start:runtime-toolkit',
    'availability:runtime-toolkit',
  ]);
});

test('LocalAgentCapabilityRegistry default toolkits include git toolkit', async () => {
  const localTool = mockTool('local-tool');
  const registry = new LocalAgentCapabilityRegistry({
    loadLocalTools: async () => [localTool],
    loadUserCapabilities: async () => [],
    createLocalToolkits: (localTools) => [
      createBashToolkit(localTools),
      createGitToolkit(),
      createBrowserToolkit(),
    ],
    resolveAvailableToolkits: async (toolkits) => toolkits,
  });

  await registry.load();

  assert.deepEqual(
    registry.getLocalToolkitDefinitions().map((item) => item.name),
    ['bash', 'git', 'browser'],
  );
  assert.ok(
    registry.getLocalCapabilities().some((item) => item.name === 'explore'),
    'default local capabilities should include explore',
  );
});
