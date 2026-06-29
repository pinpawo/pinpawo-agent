import {
  defineGuard,
  type GuardBlock,
  type GuardOptions,
  guardBlock,
  guardPass,
} from '../../../guards';
import type { OrchestratorStateType } from '../state';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  type OrchestratorGuard,
  type OrchestratorGuardConfig,
  type OrchestratorGuardUpdate,
} from './types';

function readCapabilityNameFromLane(lane: string): string | null {
  return lane.startsWith('capability:') ? lane.slice('capability:'.length) : null;
}

export type CapabilityPendingDelegationGuardBlockInput = {
  state: OrchestratorStateType;
  config: OrchestratorGuardConfig;
  result: GuardBlock;
};

export type CapabilityPendingDelegationGuardOptions = GuardOptions<
  CapabilityPendingDelegationGuardBlockInput,
  OrchestratorGuardUpdate
>;

function throwCapabilityPendingDelegationInvariant(): never {
  throw new Error('Capability node cannot run without an available pending capability delegation.');
}

export function createCapabilityPendingDelegationGuard(
  options: CapabilityPendingDelegationGuardOptions = {
    onBlock: throwCapabilityPendingDelegationInvariant,
  },
): OrchestratorGuard {
  return defineGuard<
    OrchestratorStateType,
    OrchestratorGuardConfig,
    typeof ORCHESTRATOR_GUARD_POSITION.CAPABILITY_NODE,
    OrchestratorGuardUpdate
  >({
    name: ORCHESTRATOR_GUARD_NAME.CAPABILITY_PENDING_DELEGATION,
    positions: [ORCHESTRATOR_GUARD_POSITION.CAPABILITY_NODE],
    rule: {
      check: ({ config, state }) => {
        const pending = state.runPendingDelegation;
        if (!pending) {
          return guardBlock('capability_pending_delegation_missing');
        }
        const capabilityName = readCapabilityNameFromLane(pending.lane);
        if (!capabilityName) {
          return guardBlock('capability_pending_delegation_missing');
        }
        const capability = config.capabilities?.find((item) => item.name === capabilityName);
        return capability
          ? guardPass()
          : guardBlock('capability_unavailable');
      },
    },
    handler: {
      handle: ({ config, result, state }) => result.status === 'block'
        ? options.onBlock({ state, config, result })
        : null,
    },
  });
}
