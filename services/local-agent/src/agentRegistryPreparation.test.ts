import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARTIFACT_DISCOVERY_TOOLKIT_NAME,
  defineInstructionDocument,
  type AgentCapability,
  type CapabilityArtifactStore,
} from '@pinpawo/pet-agent';
import {
  createCapabilityDiagnosticReporter,
  prepareAgentRegistry,
  projectExecutorCompilationIssues,
} from './agentRegistryPreparation';
import { resolveToolkitAvailability } from './toolkits/toolkitAvailability';

function artifactCapability(name: string): AgentCapability {
  return {
    name,
    description: `${name} capability`,
    uses: [ARTIFACT_DISCOVERY_TOOLKIT_NAME],
    instructions: defineInstructionDocument({
      content: `# ${name}`,
    }),
  };
}

test('prepareAgentRegistry keeps missing run-scoped Toolkits as compiler diagnostics', () => {
  const prepared = prepareAgentRegistry({
    toolkits: [],
    capabilities: [artifactCapability('scope_required_test')],
    generalUses: [],
  });

  assert.equal(prepared.registry.capabilities.length, 0);
  assert.equal(
    prepared.registry.unavailableCapabilities[0]?.issues[0]?.code,
    'unknown_toolkit',
  );
});

test('prepareAgentRegistry compiles artifact discovery once run scope is complete', () => {
  const prepared = prepareAgentRegistry({
    toolkits: [],
    capabilities: [artifactCapability('scope_ready_test')],
    generalUses: [],
    threadId: 'thread-1',
    capabilityArtifactStore: {} as CapabilityArtifactStore,
    authorizeArtifactDiscoveryForGeneral: true,
  });

  assert.deepEqual(
    prepared.toolkits.map(({ name }) => name),
    [ARTIFACT_DISCOVERY_TOOLKIT_NAME],
  );
  assert.deepEqual(prepared.generalUses, [ARTIFACT_DISCOVERY_TOOLKIT_NAME]);
  assert.equal(
    prepared.registry.capabilities[0]?.capability.name,
    'scope_ready_test',
  );
});

test('capability diagnostics report state transitions without module-global suppression', () => {
  const unavailable = prepareAgentRegistry({
    toolkits: [],
    capabilities: [artifactCapability('warning_state_test')],
    generalUses: [],
  });
  const available = prepareAgentRegistry({
    toolkits: [],
    capabilities: [artifactCapability('warning_state_test')],
    generalUses: [],
    threadId: 'thread-warning-state',
    capabilityArtifactStore: {} as CapabilityArtifactStore,
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
  await resolveToolkitAvailability(toolkit);
  const prepared = prepareAgentRegistry({
    toolkits: [],
    capabilities: [{
      ...artifactCapability('offline_capability'),
      uses: [toolkit.name],
    }],
    generalUses: [],
  });
  const warnings: string[] = [];
  createCapabilityDiagnosticReporter((message) => warnings.push(message))(
    prepared.registry,
    [toolkit],
  );

  assert.deepEqual(
    projectExecutorCompilationIssues([{
      code: 'unknown_toolkit',
      toolkitName: toolkit.name,
    }], [toolkit]),
    [{
      code: 'unavailable_toolkit',
      toolkitName: toolkit.name,
      reason: 'test backend is offline',
    }],
  );
  assert.match(warnings[0] ?? '', /offline_toolkit.*test backend is offline/);
});
