import {
  defineGuard,
  guardBlock,
  guardPass,
} from '../../../guards';
import type { AgentCapability } from '../../../types/capability';
import type { CapabilityCandidate, RunCapabilitySearchState } from '../types';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  statePatch,
  type OrchestratorGuard,
} from './types';

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

function buildForcedCapabilitySearchState(
  forcedNames: string[] | undefined,
  capabilities: AgentCapability[] | undefined,
): RunCapabilitySearchState | null {
  const candidates = buildForcedCapabilityCandidates(forcedNames, capabilities);
  return candidates.length > 0
    ? {
        query: null,
        attempted: true,
        candidates,
      }
    : null;
}

export function createForcedCapabilitySeedGuard(): OrchestratorGuard {
  return defineGuard({
    name: ORCHESTRATOR_GUARD_NAME.FORCED_CAPABILITY_SEED,
    positions: [ORCHESTRATOR_GUARD_POSITION.CAPABILITY_DISCOVERY],
    rule: {
      check: ({ config, state }) => {
        if (
          state.runCapabilitySearchState.attempted
          || state.runCapabilitySearchState.candidates.length > 0
        ) {
          return guardPass();
        }
        return buildForcedCapabilitySearchState(config.forcedCapabilityNames, config.capabilities)
          ? guardBlock('forced_capability_seed_required')
          : guardPass();
      },
    },
    handler: {
      handle: ({ config, result }) => {
        if (result.status === 'pass') {
          return null;
        }
        const runCapabilitySearchState = buildForcedCapabilitySearchState(
          config.forcedCapabilityNames,
          config.capabilities,
        );
        return runCapabilitySearchState
          ? statePatch({ runCapabilitySearchState })
          : null;
      },
    },
  });
}
