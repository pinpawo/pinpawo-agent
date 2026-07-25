import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARTIFACT_DISCOVERY_TOOLKIT_NAME,
  defineInstructionDocument,
  type AgentCapability,
  type CapabilityArtifactStore,
} from '@pinpawo/pet-agent';
import {
  prepareAgentRegistry,
  reportUnavailableCapabilities,
} from './agentRegistryPreparation';

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

test('reportUnavailableCapabilities warns once for the same diagnostics fingerprint', () => {
  const prepared = prepareAgentRegistry({
    toolkits: [],
    capabilities: [artifactCapability('warn_once_unique_test')],
    generalUses: [],
  });
  const warnings: string[] = [];

  reportUnavailableCapabilities(prepared.registry, (message) => warnings.push(message));
  reportUnavailableCapabilities(prepared.registry, (message) => warnings.push(message));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /warn_once_unique_test.*unknown Toolkit "artifact_discovery"/);
});
