import { defineCapability, type AgentCapability } from '../../types/capability';
import { type AgentToolkit, validateToolkitDefinition } from '../../types/toolkit';

export function validateUniqueCapabilityNames(capabilities: AgentCapability[]) {
  const seen = new Set<string>();
  for (const capability of capabilities) {
    defineCapability(capability);
    if (seen.has(capability.name)) {
      throw new Error(`Duplicate capability name: ${capability.name}`);
    }
    seen.add(capability.name);
  }
}

export function validateUniqueToolkitNames(toolkits: AgentToolkit[]) {
  const seen = new Set<string>();
  for (const toolkit of toolkits) {
    validateToolkitDefinition(toolkit);
    if (seen.has(toolkit.name)) {
      throw new Error(`Duplicate toolkit name: ${toolkit.name}`);
    }
    seen.add(toolkit.name);
  }
}
