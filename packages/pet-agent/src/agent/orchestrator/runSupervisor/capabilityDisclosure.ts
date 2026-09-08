import type { CapabilityDocumentWorkspace } from './documentWorkspace';

export type CapabilityDisclosureState = {
  readonly registryDigest: string;
  readonly disclosedCapabilityNames: readonly string[];
};

export function createCapabilityDisclosureState(params: {
  workspace: CapabilityDocumentWorkspace;
  seedCapabilityNames?: readonly string[];
}): CapabilityDisclosureState {
  return {
    registryDigest: params.workspace.registryDigest,
    disclosedCapabilityNames: [...new Set((params.seedCapabilityNames ?? [])
      .filter((name) => params.workspace.capabilityNames.includes(name)))],
  };
}

/** A registry generation change begins a new disclosure scope. */
export function resolveCapabilityDisclosureState(params: {
  current: CapabilityDisclosureState | null;
  workspace: CapabilityDocumentWorkspace;
  seedCapabilityNames?: readonly string[];
}): CapabilityDisclosureState {
  if (!params.current || params.current.registryDigest !== params.workspace.registryDigest) {
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
