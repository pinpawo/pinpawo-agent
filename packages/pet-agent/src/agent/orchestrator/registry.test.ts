import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  defineInstructionDocument,
  type AgentCapability,
} from '../../types/capability';
import { defineToolkit } from '../../types/toolkit';
import { compileAgentRegistry } from './registry';

function mockTool(name: string) {
  return tool(async () => 'ok', {
    name,
    description: `${name} tool`,
    schema: z.object({}),
  });
}

function capability(name: string, uses: readonly string[]): AgentCapability {
  return {
    name,
    description: `${name} capability`,
    uses,
    instructions: defineInstructionDocument({
      content: `Execute the ${name} capability.`,
    }),
  };
}

test('registry compiles Capability Toolkit dependencies in declared order', () => {
  const bash = defineToolkit({
    name: 'bash',
    description: 'Bash tools.',
    tools: [{ tool: mockTool('read_file') }],
  });
  const git = defineToolkit({
    name: 'git',
    description: 'Git tools.',
    tools: [{ tool: mockTool('git_status') }],
  });

  const registry = compileAgentRegistry({
    toolkits: [bash, git],
    capabilities: [
      capability('general', ['bash']),
      capability('inspect', ['git', 'bash']),
    ],
  });

  assert.deepEqual(
    registry.capabilities[0]?.toolNames,
    ['read_file'],
  );
  assert.deepEqual(
    registry.capabilities[1]?.toolkits.map((toolkit) => toolkit.name),
    ['git', 'bash'],
  );
  assert.deepEqual(
    registry.capabilities[1]?.toolNames,
    ['git_status', 'read_file'],
  );
});

test('registry excludes a Capability with an unknown required Toolkit before routing', () => {
  const registry = compileAgentRegistry({
    toolkits: [],
    capabilities: [capability('web_research', ['browser'])],
  });

  assert.deepEqual(registry.capabilities, []);
  assert.equal(registry.unavailableCapabilities[0]?.capability.name, 'web_research');
  assert.deepEqual(registry.unavailableCapabilities[0]?.issues, [{
    code: 'unknown_toolkit',
    toolkitName: 'browser',
  }]);
});

test('registry isolates a Capability whose Toolkits expose duplicate tools', () => {
  const first = defineToolkit({
    name: 'first',
    description: 'First toolkit.',
    tools: [{ tool: mockTool('shared_tool') }],
  });
  const second = defineToolkit({
    name: 'second',
    description: 'Second toolkit.',
    tools: [{ tool: mockTool('shared_tool') }],
  });
  const registry = compileAgentRegistry({
    toolkits: [first, second],
    capabilities: [
      capability('conflicted', ['first', 'second']),
      capability('healthy', ['first']),
    ],
  });

  assert.deepEqual(registry.capabilities.map(({ capability: item }) => item.name), ['healthy']);
  assert.deepEqual(registry.unavailableCapabilities[0]?.issues, [{
    code: 'duplicate_tool',
    toolName: 'shared_tool',
    toolkitNames: ['first', 'second'],
  }]);
});

test('registry isolates a general fallback Capability with duplicate tools', () => {
  const first = defineToolkit({
    name: 'first',
    description: 'First toolkit.',
    tools: [{ tool: mockTool('shared_tool') }],
  });
  const second = defineToolkit({
    name: 'second',
    description: 'Second toolkit.',
    tools: [{ tool: mockTool('shared_tool') }],
  });

  const registry = compileAgentRegistry({
    toolkits: [first, second],
    capabilities: [
      capability('general', ['first', 'second']),
      capability('healthy', ['first']),
    ],
  });

  assert.deepEqual(
    registry.capabilities.map(({ capability: item }) => item.name),
    ['healthy'],
  );
  assert.equal(
    registry.unavailableCapabilities[0]?.capability.name,
    'general',
  );
});

test('compiled registry snapshots Toolkit definitions for one generation', () => {
  const original = mockTool('original');
  const replacement = mockTool('replacement');
  const toolkit = {
    name: 'mutable',
    description: 'Mutable source definition.',
    tools: [{ tool: original }],
  };
  const registry = compileAgentRegistry({
    toolkits: [toolkit],
    capabilities: [capability('general', ['mutable'])],
  });

  toolkit.tools = [{ tool: replacement }];

  assert.deepEqual(
    registry.capabilities[0]?.toolkits.flatMap((item) =>
      item.tools.map(({ tool: toolItem }) => toolItem.name)),
    ['original'],
  );
  assert.deepEqual(registry.capabilities[0]?.toolNames, ['original']);
  assert.ok(Object.isFrozen(registry.capabilities[0]?.toolkits[0]?.tools));
});
