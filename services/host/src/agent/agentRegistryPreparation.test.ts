import assert from 'node:assert/strict';
import test from 'node:test';
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

function artifactCapability(name: string): AgentCapability {
  return {
    name,
    description: `${name} capability`,
    uses: ['artifact_discovery'],
    instructions: defineInstructionDocument({
      content: `# ${name}`,
    }),
  };
}

test('retired artifact discovery remains an explicit dependency diagnostic for external Capabilities', () => {
  const prepared = prepareAgentRegistry({
    toolkits: [],
    capabilities: [artifactCapability('scope_required_test')],
  });

  assert.equal(prepared.registry.capabilities.length, 0);
  assert.deepEqual(prepared.toolkits, []);
  assert.deepEqual(prepared.registry.unavailableCapabilities[0]?.capability.uses, ['artifact_discovery']);
  assert.equal(
    prepared.registry.unavailableCapabilities[0]?.issues[0]?.code,
    'unknown_toolkit',
  );
});

test('capability diagnostics report state transitions without module-global suppression', () => {
  const unavailable = prepareAgentRegistry({
    toolkits: [],
    capabilities: [artifactCapability('warning_state_test')],
  });
  const available = prepareAgentRegistry({
    toolkits: [],
    capabilities: [{ ...artifactCapability('warning_state_test'), uses: [] }],
  });
  const warnings: string[] = [];
  const report = createCapabilityDiagnosticReporter((message) => warnings.push(message));

  report(unavailable.registry);
  report(unavailable.registry);
  report(available.registry);
  report(unavailable.registry);

  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? '', /warning_state_test.*unknown Toolkit "artifact_discovery"/);
  assert.match(warnings[1] ?? '', /warning_state_test.*unknown Toolkit "artifact_discovery"/);
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
      ...artifactCapability('offline_capability'),
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
