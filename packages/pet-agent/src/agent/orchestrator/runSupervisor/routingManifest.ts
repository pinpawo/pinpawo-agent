import type { CapabilityCatalog } from './capabilityCatalog';
import { GENERAL_CAPABILITY_NAME } from '../../../types/capability';

export type CapabilityRoutingManifest = {
  readonly defaultCapabilityName?: string;
  readonly capabilities: ReadonlyArray<{
    readonly name: string;
    readonly purpose: string;
    readonly toolkits: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  }>;
};

export function createCapabilityRoutingManifest(params: {
  catalog: CapabilityCatalog;
  defaultCapabilityName?: string;
}): CapabilityRoutingManifest {
  const defaultName = params.defaultCapabilityName ?? GENERAL_CAPABILITY_NAME;
  return {
    ...(params.catalog.capabilityNames.includes(defaultName) ? { defaultCapabilityName: defaultName } : {}),
    capabilities: params.catalog.entries.map((entry) => ({
      name: entry.capabilityName,
      purpose: entry.description,
      toolkits: entry.toolkits,
    })),
  };
}
