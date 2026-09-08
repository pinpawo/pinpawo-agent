import type { CapabilityCatalog } from './capabilityCatalog';

export type CapabilityDisclosureState = {
  readonly registryDigest: string;
  readonly disclosedCapabilityNames: readonly string[];
};

export function createCapabilityDisclosureState(params: {
  catalog: CapabilityCatalog;
  seedCapabilityNames?: readonly string[];
}): CapabilityDisclosureState {
  return {
    registryDigest: params.catalog.registryDigest,
    disclosedCapabilityNames: [...new Set((params.seedCapabilityNames ?? [])
      .filter((name) => params.catalog.capabilityNames.includes(name)))],
  };
}

/** A registry generation change begins a new disclosure scope. */
export function resolveCapabilityDisclosureState(params: {
  current: CapabilityDisclosureState | null;
  catalog: CapabilityCatalog;
  seedCapabilityNames?: readonly string[];
}): CapabilityDisclosureState {
  if (!params.current || params.current.registryDigest !== params.catalog.registryDigest) {
    return createCapabilityDisclosureState(params);
  }
  return params.current;
}

export function mergeCapabilityDisclosure(
  current: CapabilityDisclosureState,
  names: readonly string[],
): CapabilityDisclosureState {
  return {
    registryDigest: current.registryDigest,
    disclosedCapabilityNames: [...new Set([...current.disclosedCapabilityNames, ...names])],
  };
}
