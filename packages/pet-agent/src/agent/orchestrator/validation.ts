import type { StructuredTool } from '@langchain/core/tools';
import type { AgentCapability } from '../../types/capability';
import { type AgentToolkit, validateToolkitDefinition } from '../../types/toolkit';

export function validateUniqueCapabilityNames(capabilities: AgentCapability[]) {
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (seen.has(capability.name)) {
      throw new Error(`Duplicate capability name: ${capability.name}`);
    }
    seen.add(capability.name);
  }
}

export function validateUniqueToolNames(tools: StructuredTool[]) {
  const seen = new Set<string>();
  for (const toolItem of tools) {
    if (seen.has(toolItem.name)) {
      throw new Error(`Duplicate tool name: ${toolItem.name}`);
    }
    seen.add(toolItem.name);
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
