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

const reportedDiagnosticFingerprints = new Set<string>();

export function prepareAgentRegistry(params: {
  toolkits: readonly AgentToolkit[];
  capabilities: readonly AgentCapability[];
  generalUses: readonly string[];
  threadId?: string;
  capabilityArtifactStore?: CapabilityArtifactStore;
  authorizeArtifactDiscoveryForGeneral?: boolean;
}) {
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

  return {
    registry: compileAgentRegistry({
      toolkits,
      capabilities: params.capabilities,
      generalUses,
    }),
    toolkits,
    generalUses,
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
