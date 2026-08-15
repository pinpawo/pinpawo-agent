import {
  ARTIFACT_DISCOVERY_TOOLKIT_NAME,
  compileAgentRegistry,
  formatExecutorCompilationIssues,
  type AgentCapability,
  type AgentToolkit,
  type CapabilityArtifactStore,
  type CompiledAgentRegistry,
  type ExecutorCompilationIssue,
} from '@pinpawo/pet-agent';
import { createArtifactDiscoveryToolkit } from './toolkits/local';
import type { ToolkitInventoryEntry } from './toolkits/toolkitInventory';

/**
 * Host-facing diagnostic projection. The core compiler intentionally reports
 * only structural `unknown_toolkit`; local-agent can distinguish a definition
 * that was registered but filtered out by the current Host inventory.
 */
export type ProjectedExecutorCompilationIssue =
  | Exclude<ExecutorCompilationIssue, { code: 'unknown_toolkit' }>
  | Extract<ExecutorCompilationIssue, { code: 'unknown_toolkit' }>
  | {
      code: 'unavailable_toolkit';
      toolkitName: string;
      reason: string;
    };

export type CapabilityDiagnosticReporter = (
  registry: CompiledAgentRegistry,
  toolkitInventoryEntries?: readonly ToolkitInventoryEntry[],
) => void;

export function prepareAgentRegistry(params: {
  toolkits: readonly AgentToolkit[];
  capabilities: readonly AgentCapability[];
  threadId?: string;
  capabilityArtifactStore?: CapabilityArtifactStore;
}) {
  const toolkits = [...params.toolkits];
  const hasArtifactDiscoveryToolkit = toolkits.some(
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
  }

  return {
    registry: compileAgentRegistry({
      toolkits,
      capabilities: params.capabilities,
    }),
    toolkits,
  };
}

function unavailableToolkitAvailabilityByName(
  toolkitInventoryEntries: readonly ToolkitInventoryEntry[],
) {
  const result = new Map<string, Extract<ToolkitInventoryEntry['availability'], {
    available: false;
  }>>();
  for (const { toolkit, availability } of toolkitInventoryEntries) {
    if (availability.available === false && !result.has(toolkit.name)) {
      result.set(toolkit.name, availability);
    }
  }
  return result;
}

export function projectExecutorCompilationIssues(
  issues: readonly ExecutorCompilationIssue[],
  toolkitInventoryEntries: readonly ToolkitInventoryEntry[] = [],
): ProjectedExecutorCompilationIssue[] {
  const unavailableByName = unavailableToolkitAvailabilityByName(toolkitInventoryEntries);
  return issues.map((issue) => {
    if (issue.code !== 'unknown_toolkit') return issue;
    const availability = unavailableByName.get(issue.toolkitName);
    return availability
      ? {
          code: 'unavailable_toolkit',
          toolkitName: issue.toolkitName,
          reason: availability.reason,
        }
      : issue;
  });
}

function formatProjectedIssues(
  issues: readonly ProjectedExecutorCompilationIssue[],
) {
  return issues.map((issue) => {
    if (issue.code === 'unavailable_toolkit') {
      return `unavailable Toolkit "${issue.toolkitName}" (${issue.reason})`;
    }
    return formatExecutorCompilationIssues([issue]);
  }).join('; ');
}

export function createCapabilityDiagnosticReporter(
  warn: (message: string) => void = console.warn,
): CapabilityDiagnosticReporter {
  const reportedByCapability = new Map<string, string>();

  return (registry, toolkitInventoryEntries = []) => {
    const currentCapabilityNames = new Set([
      ...registry.capabilities.map(({ capability }) => capability.name),
      ...registry.unavailableCapabilities.map(({ capability }) => capability.name),
    ]);
    for (const capabilityName of reportedByCapability.keys()) {
      if (!currentCapabilityNames.has(capabilityName)) {
        reportedByCapability.delete(capabilityName);
      }
    }
    for (const { capability } of registry.capabilities) {
      reportedByCapability.delete(capability.name);
    }

    for (const unavailable of registry.unavailableCapabilities) {
      const formattedIssues = formatProjectedIssues(
        projectExecutorCompilationIssues(
          unavailable.issues,
          toolkitInventoryEntries,
        ),
      );
      if (reportedByCapability.get(unavailable.capability.name) === formattedIssues) {
        continue;
      }
      reportedByCapability.set(unavailable.capability.name, formattedIssues);
      warn(
        `[capabilities] "${unavailable.capability.name}" unavailable: ${formattedIssues}`,
      );
    }
  };
}
