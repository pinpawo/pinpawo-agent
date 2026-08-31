import { GENERAL_CAPABILITY_NAME } from '../../../types/capability';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';

export type CapabilityDisclosureState = {
  readonly registryDigest: string;
  /** Default candidate used when this disclosure generation was initialized. */
  readonly defaultCapabilityName?: string;
  readonly disclosedCapabilityNames: readonly string[];
  readonly emptySearchRounds: number;
  readonly maxEmptySearchRounds: number;
  readonly status: 'open' | 'closed';
};

export type CapabilitySearchObservation = {
  readonly modelMessageId: string;
  readonly toolCallId: string;
  /** Capability names first disclosed by this search call. */
  readonly disclosedCapabilityNames: readonly string[];
};

function disclosureStatus(emptySearchRounds: number, maxEmptySearchRounds: number) {
  return emptySearchRounds >= maxEmptySearchRounds ? 'closed' as const : 'open' as const;
}

export function createCapabilityDisclosureState(params: {
  workspace: CapabilityDocumentWorkspace;
  maxEmptySearchRounds: number;
  defaultCapabilityName?: string;
  seedCapabilityNames?: readonly string[];
}): CapabilityDisclosureState {
  const { workspace, maxEmptySearchRounds } = params;
  if (!Number.isSafeInteger(maxEmptySearchRounds) || maxEmptySearchRounds <= 0) {
    throw new Error('Run Supervisor maxEmptySearchRounds must be a positive integer');
  }
  const defaultCapabilityName = params.defaultCapabilityName
    ?? GENERAL_CAPABILITY_NAME;
  if (!defaultCapabilityName.trim()) {
    throw new Error('Run Supervisor defaultCapabilityName must be non-empty');
  }
  const disclosedCapabilityNames = [...new Set([
    ...(workspace.capabilityNames.includes(defaultCapabilityName)
      ? [defaultCapabilityName]
      : []),
    ...(params.seedCapabilityNames ?? []).filter((name) =>
      workspace.capabilityNames.includes(name),
    ),
  ])];
  return {
    registryDigest: workspace.registryDigest,
    defaultCapabilityName,
    disclosedCapabilityNames,
    emptySearchRounds: 0,
    maxEmptySearchRounds,
    status: 'open',
  };
}

/**
 * Keep discovery run-scoped while making a registry generation change an
 * explicit new disclosure boundary.
 */
export function resolveCapabilityDisclosureState(params: {
  current: CapabilityDisclosureState | null;
  workspace: CapabilityDocumentWorkspace;
  maxEmptySearchRounds: number;
  defaultCapabilityName?: string;
  seedCapabilityNames?: readonly string[];
}) {
  const defaultCapabilityName = params.defaultCapabilityName
    ?? GENERAL_CAPABILITY_NAME;
  if (!params.current
    || params.current.registryDigest !== params.workspace.registryDigest
    || params.current.defaultCapabilityName !== defaultCapabilityName) {
    return createCapabilityDisclosureState({
      ...params,
      defaultCapabilityName,
    });
  }
  return params.current;
}

/**
 * Drop every Capability learned through search while retaining the run's
 * discovery-round accounting. Only the configured default disclosure
 * survives this size-limit fallback.
 */
export function removeSearchedCapabilities(params: {
  current: CapabilityDisclosureState;
  workspace: CapabilityDocumentWorkspace;
}): CapabilityDisclosureState {
  const defaultCapabilityName = params.current.defaultCapabilityName
    ?? GENERAL_CAPABILITY_NAME;
  const disclosedCapabilityNames = params.workspace.capabilityNames.includes(
    defaultCapabilityName,
  ) ? [defaultCapabilityName] : [];
  return {
    ...params.current,
    disclosedCapabilityNames,
  };
}

/**
 * Project invocation-local search observations back into the run session
 * state. Parallel calls owned by one AI message form one search round.
 */
export function applyCapabilitySearchObservations(
  current: CapabilityDisclosureState,
  observations: readonly CapabilitySearchObservation[],
): CapabilityDisclosureState {
  const disclosedCapabilityNames = [...current.disclosedCapabilityNames];
  const knownNames = new Set(disclosedCapabilityNames);
  const rounds = new Map<string, boolean>();

  for (const observation of observations) {
    let roundDisclosedNewCapability = rounds.get(observation.modelMessageId) ?? false;
    for (const capabilityName of observation.disclosedCapabilityNames) {
      if (knownNames.has(capabilityName)) continue;
      knownNames.add(capabilityName);
      disclosedCapabilityNames.push(capabilityName);
      roundDisclosedNewCapability = true;
    }
    rounds.set(observation.modelMessageId, roundDisclosedNewCapability);
  }

  const emptySearchRounds = current.emptySearchRounds
    + [...rounds.values()].filter((disclosedNewCapability) => !disclosedNewCapability).length;
  return {
    ...current,
    disclosedCapabilityNames,
    emptySearchRounds,
    status: disclosureStatus(emptySearchRounds, current.maxEmptySearchRounds),
  };
}
