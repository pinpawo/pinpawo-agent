import {
  ARTIFACT_DISCOVERY_TOOLKIT_NAME,
  compileAgentRegistry,
  formatExecutorCompilationIssues,
  type AgentCapability,
  type AgentToolkit,
  type CapabilityArtifactStore,
  type CompiledAgentRegistry,
} from '@pinpawo/pet-agent';
import { createArtifactDiscoveryToolkit } from './toolkits/local';

export type AgentRegistryScopeRequirement =
  | 'threadId'
  | 'capabilityArtifactStore';

export type PreparedAgentRegistry = {
  registry: CompiledAgentRegistry;
  toolkits: readonly AgentToolkit[];
  generalUses: readonly string[];
  scopeRequirements: ReadonlyMap<string, readonly AgentRegistryScopeRequirement[]>;
};

const reportedDiagnosticFingerprints = new Set<string>();

function requiredArtifactDiscoveryScope(params: {
  threadId?: string;
  capabilityArtifactStore?: CapabilityArtifactStore;
}): AgentRegistryScopeRequirement[] {
  const required: AgentRegistryScopeRequirement[] = [];
  if (!params.threadId) required.push('threadId');
  if (!params.capabilityArtifactStore) required.push('capabilityArtifactStore');
  return required;
}

export function prepareAgentRegistry(params: {
  toolkits: readonly AgentToolkit[];
  capabilities: readonly AgentCapability[];
  generalUses: readonly string[];
  threadId?: string;
  capabilityArtifactStore?: CapabilityArtifactStore;
  authorizeArtifactDiscoveryForGeneral?: boolean;
}): PreparedAgentRegistry {
  const toolkits = [...params.toolkits];
  let hasArtifactDiscoveryToolkit = toolkits.some(
    ({ name }) => name === ARTIFACT_DISCOVERY_TOOLKIT_NAME,
  );

  if (
    !hasArtifactDiscoveryToolkit
    && params.threadId
    && params.capabilityArtifactStore
  ) {
    toolkits.push(createArtifactDiscoveryToolkit({
      store: params.capabilityArtifactStore,
      threadId: params.threadId,
    }));
    hasArtifactDiscoveryToolkit = true;
  }

  const generalUses = [...params.generalUses];
  if (
    hasArtifactDiscoveryToolkit
    && params.authorizeArtifactDiscoveryForGeneral
    && !generalUses.includes(ARTIFACT_DISCOVERY_TOOLKIT_NAME)
  ) {
    generalUses.push(ARTIFACT_DISCOVERY_TOOLKIT_NAME);
  }

  const scopeRequirements = new Map<
    string,
    readonly AgentRegistryScopeRequirement[]
  >();
  if (!hasArtifactDiscoveryToolkit) {
    const required = requiredArtifactDiscoveryScope(params);
    for (const capability of params.capabilities) {
      if (capability.uses.includes(ARTIFACT_DISCOVERY_TOOLKIT_NAME)) {
        scopeRequirements.set(capability.name, required);
      }
    }
  }

  return {
    registry: compileAgentRegistry({
      toolkits,
      capabilities: params.capabilities,
      generalUses,
    }),
    toolkits,
    generalUses,
    scopeRequirements,
  };
}

function diagnosticFingerprint(
  capabilityName: string,
  formattedIssues: string,
) {
  return `${capabilityName}\n${formattedIssues}`;
}

export function reportUnavailableCapabilities(
  registry: CompiledAgentRegistry,
  warn: (message: string) => void = console.warn,
) {
  for (const unavailable of registry.unavailableCapabilities) {
    const formattedIssues = formatExecutorCompilationIssues(unavailable.issues);
    const fingerprint = diagnosticFingerprint(
      unavailable.capability.name,
      formattedIssues,
    );
    if (reportedDiagnosticFingerprints.has(fingerprint)) continue;
    reportedDiagnosticFingerprints.add(fingerprint);
    warn(
      `[capabilities] "${unavailable.capability.name}" unavailable: ${formattedIssues}`,
    );
  }
}
