import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  defineInstructionDocument,
  type AgentCapability,
} from '@pinpawo/pet-agent';
import {
  createCapabilityDiagnosticReporter,
  prepareAgentRegistry,
  projectExecutorCompilationIssues,
} from './agentRegistryPreparation';
import type { ToolkitInventoryEntry } from '../toolkits/toolkitInventory';

function toolkitCapability(name: string): AgentCapability {
  return {
    name,
    description: `${name} capability`,
    uses: ['provided_toolkit'],
    instructions: defineInstructionDocument({
      content: `# ${name}`,
    }),
  };
}

test('prepareAgentRegistry keeps missing run-scoped Toolkits as compiler diagnostics', () => {
  const prepared = prepareAgentRegistry({
    toolkits: [],
    capabilities: [toolkitCapability('scope_required_test')],
  });

  assert.equal(prepared.registry.capabilities.length, 0);
  assert.equal(
    prepared.registry.unavailableCapabilities[0]?.issues[0]?.code,
    'unknown_toolkit',
  );
});

test('prepareAgentRegistry compiles caller-supplied Toolkits', () => {
  const prepared = prepareAgentRegistry({
    toolkits: [{ name: 'provided_toolkit', description: 'Provided.', tools: [{ tool: tool(() => 'ok', {
      name: 'probe', description: 'Probe.', schema: z.object({}),
    }) }] }],
    capabilities: [toolkitCapability('scope_ready_test')],
  });

  assert.deepEqual(
    prepared.toolkits.map(({ name }) => name),
    ['provided_toolkit'],
  );
  assert.equal(
    prepared.registry.capabilities[0]?.capability.name,
    'scope_ready_test',
  );
});

test('capability diagnostics report state transitions without module-global suppression', () => {
  const unavailable = prepareAgentRegistry({
    toolkits: [],
    capabilities: [toolkitCapability('warning_state_test')],
  });
  const available = prepareAgentRegistry({
    toolkits: [{ name: 'provided_toolkit', description: 'Provided.', tools: [{ tool: tool(() => 'ok', {
      name: 'probe', description: 'Probe.', schema: z.object({}),
    }) }] }],
    capabilities: [toolkitCapability('warning_state_test')],
  });
  const warnings: string[] = [];
  const report = createCapabilityDiagnosticReporter((message) => warnings.push(message));

  report(unavailable.registry);
  report(unavailable.registry);
  report(available.registry);
  report(unavailable.registry);

  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? '', /warning_state_test.*unknown Toolkit "provided_toolkit"/);
  assert.match(warnings[1] ?? '', /warning_state_test.*unknown Toolkit "provided_toolkit"/);
});

test('capability diagnostics preserve a known unavailable Toolkit reason', async () => {
  const toolkit = {
    name: 'offline_toolkit',
    description: 'offline toolkit',
    tools: [],
    availability: () => ({
      available: false as const,
      reason: 'test backend is offline',
    }),
  };
  const inventoryEntry: ToolkitInventoryEntry = {
    toolkit,
    provenance: {
      sourceId: 'test-host',
      sourceKind: 'host_builtin',
      sourceIndex: 0,
      definitionIndex: 0,
    },
    availability: {
      available: false,
      reason: 'test backend is offline',
    },
  };
  const prepared = prepareAgentRegistry({
    toolkits: [],
    capabilities: [{
      ...toolkitCapability('offline_capability'),
      uses: [toolkit.name],
    }],
  });
  const warnings: string[] = [];
  createCapabilityDiagnosticReporter((message) => warnings.push(message))(
    prepared.registry,
    [inventoryEntry],
  );

  assert.deepEqual(
    projectExecutorCompilationIssues([{
      code: 'unknown_toolkit',
      toolkitName: toolkit.name,
    }], [inventoryEntry]),
    [{
      code: 'unavailable_toolkit',
      toolkitName: toolkit.name,
      reason: 'test backend is offline',
    }],
  );
  assert.match(warnings[0] ?? '', /offline_toolkit.*test backend is offline/);
});
