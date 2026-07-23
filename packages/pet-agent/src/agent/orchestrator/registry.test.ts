import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentCapability } from '../../types/capability';
import { defineToolkit } from '../../types/toolkit';
import {
  compileAgentRegistry,
  ExecutorCompilationError,
} from './registry';

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
    createRuntime: () => ({}),
  };
}

test('registry compiles general and Capability Toolkit dependencies in declared order', () => {
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
    capabilities: [capability('inspect', ['git', 'bash'])],
    generalUses: ['bash'],
  });

  assert.deepEqual(registry.general.toolNames, ['read_file']);
  assert.deepEqual(
    registry.capabilities[0]?.toolkits.map((toolkit) => toolkit.name),
    ['git', 'bash'],
  );
  assert.deepEqual(
    registry.capabilities[0]?.toolNames,
    ['git_status', 'read_file'],
  );
});

test('registry excludes a Capability with an unknown required Toolkit before routing', () => {
  const registry = compileAgentRegistry({
    toolkits: [],
    capabilities: [capability('web_research', ['browser'])],
    generalUses: [],
  });

  assert.deepEqual(registry.capabilities, []);
  assert.equal(registry.unavailableCapabilities[0]?.capability.name, 'web_research');
  assert.deepEqual(registry.unavailableCapabilities[0]?.issues, [{
    code: 'unknown_toolkit',
    toolkitName: 'browser',
  }]);
});

test('registry rejects invalid explicit general authorization', () => {
  assert.throws(
    () => compileAgentRegistry({
      toolkits: [],
      capabilities: [],
      generalUses: ['missing'],
    }),
    (error: unknown) => {
      assert.ok(error instanceof ExecutorCompilationError);
      assert.match(error.message, /General executor.*unknown Toolkit "missing"/);
      return true;
    },
  );
});

test('registry fails fast on duplicate tools within one effective executor', () => {
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
  assert.throws(
    () => compileAgentRegistry({
      toolkits: [first, second],
      capabilities: [capability('conflicted', ['first', 'second'])],
      generalUses: ['first'],
    }),
    (error: unknown) => {
      assert.ok(error instanceof ExecutorCompilationError);
      assert.deepEqual(error.issues, [{
        code: 'duplicate_tool',
        toolName: 'shared_tool',
        toolkitNames: ['first', 'second'],
      }]);
      return true;
    },
  );
});
