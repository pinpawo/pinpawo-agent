import {
  defineGuard,
  guardDerive,
  guardProceed,
} from '../../../guards';
import type { AgentCapability } from '../../../types/capability';
import type { CapabilityCandidate, RunCapabilitySearchState } from '../types';
import type { OrchestratorStateType } from '../state';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  type ForcedCapabilitySeedGuardConfig,
  type OrchestratorGuardPosition,
} from './types';

export const FORCED_CAPABILITY_SEED_REQUIRED = 'forced_capability_seed_required';

export type ForcedCapabilitySeedGuardState = Pick<OrchestratorStateType, 'runCapabilitySearchState'>;

/** Details carried by a `forced_capability_seed_required` derive outcome. */
export type ForcedCapabilitySeedDetails = {
  runCapabilitySearchState: RunCapabilitySearchState;
  seededCapabilityNames: string[];
};

function buildForcedCapabilityCandidates(
  forcedNames: string[] | undefined,
  capabilities: AgentCapability[] | undefined,
): CapabilityCandidate[] {
  if (!forcedNames || forcedNames.length === 0 || !capabilities || capabilities.length === 0) {
    return [];
  }
  const candidates: CapabilityCandidate[] = [];
  const seen = new Set<string>();
  for (const name of forcedNames) {
    if (seen.has(name)) continue;
    const capability = capabilities.find((item) => item.name === name);
    if (!capability) continue;
    seen.add(name);
    candidates.push({
      name: capability.name,
      description: capability.description,
      score: Number.POSITIVE_INFINITY,
      matchedTerms: ['forced'],
    });
  }
  return candidates;
}

export const forcedCapabilitySeedGuard = defineGuard<
  ForcedCapabilitySeedGuardState,
  ForcedCapabilitySeedGuardConfig,
  OrchestratorGuardPosition
>({
  name: ORCHESTRATOR_GUARD_NAME.FORCED_CAPABILITY_SEED,
  positions: [ORCHESTRATOR_GUARD_POSITION.CAPABILITY_DISCOVERY],
  check: ({ config, state }) => {
    if (
      state.runCapabilitySearchState.attempted
      || state.runCapabilitySearchState.candidates.length > 0
    ) {
      return guardProceed();
    }
    const candidates = buildForcedCapabilityCandidates(
      config.forcedCapabilityNames,
      config.capabilities,
    );
    if (candidates.length === 0) {
      return guardProceed();
    }
    const details: ForcedCapabilitySeedDetails = {
      runCapabilitySearchState: {
        query: null,
        attempted: true,
        candidates,
      },
      seededCapabilityNames: candidates.map((candidate) => candidate.name),
    };
    return guardDerive(FORCED_CAPABILITY_SEED_REQUIRED, details);
  },
});
