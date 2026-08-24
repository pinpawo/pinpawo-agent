import { GENERAL_CAPABILITY_NAME } from '../../../types/capability';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';

export type CapabilityDisclosureState = {
  readonly registryDigest: string;
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
}): CapabilityDisclosureState {
  const { workspace, maxEmptySearchRounds } = params;
  if (!Number.isSafeInteger(maxEmptySearchRounds) || maxEmptySearchRounds <= 0) {
    throw new Error('Capability Planner maxEmptySearchRounds must be a positive integer');
  }
  const disclosedCapabilityNames = workspace.capabilityNames.includes(
    GENERAL_CAPABILITY_NAME,
  ) ? [GENERAL_CAPABILITY_NAME] : [];
  return {
    registryDigest: workspace.registryDigest,
    disclosedCapabilityNames,
    emptySearchRounds: 0,
    maxEmptySearchRounds,
    status: 'open',
  };
}

/**
 * Keep discovery trace-scoped while making a registry generation change an
 * explicit new disclosure boundary.
 */
export function resolveCapabilityDisclosureState(params: {
  current: CapabilityDisclosureState | null;
  workspace: CapabilityDocumentWorkspace;
  maxEmptySearchRounds: number;
}) {
  if (!params.current
    || params.current.registryDigest !== params.workspace.registryDigest) {
    return createCapabilityDisclosureState(params);
  }
  return params.current;
}

/**
 * Drop every Capability learned through search while retaining the trace's
 * discovery-round accounting. General is the only default disclosure and is
 * therefore the only document that survives this size-limit fallback.
 */
export function removeSearchedCapabilities(params: {
  current: CapabilityDisclosureState;
  workspace: CapabilityDocumentWorkspace;
}): CapabilityDisclosureState {
  const disclosedCapabilityNames = params.workspace.capabilityNames.includes(
    GENERAL_CAPABILITY_NAME,
  ) ? [GENERAL_CAPABILITY_NAME] : [];
  return {
    ...params.current,
    disclosedCapabilityNames,
  };
}

/**
 * Project invocation-local search observations back into persistent trace
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
