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

export type GeneralPendingDelegationGuardBlockInput = {
  state: OrchestratorStateType;
  config: OrchestratorGuardConfig;
  result: GuardBlock;
};

export type GeneralPendingDelegationGuardOptions = GuardOptions<
  GeneralPendingDelegationGuardBlockInput,
  OrchestratorGuardUpdate
>;

function throwGeneralPendingDelegationInvariant(): never {
  throw new Error('General node cannot run without a pending general delegation.');
}

export function createGeneralPendingDelegationGuard(
  options: GeneralPendingDelegationGuardOptions = {
    onBlock: throwGeneralPendingDelegationInvariant,
  },
): OrchestratorGuard {
  return defineGuard<
    OrchestratorStateType,
    OrchestratorGuardConfig,
    typeof ORCHESTRATOR_GUARD_POSITION.GENERAL_NODE,
    OrchestratorGuardUpdate
  >({
    name: ORCHESTRATOR_GUARD_NAME.GENERAL_PENDING_DELEGATION,
    positions: [ORCHESTRATOR_GUARD_POSITION.GENERAL_NODE],
    rule: {
      check: ({ state }) => state.runPendingDelegation?.lane === 'general'
        ? guardPass()
        : guardBlock('general_pending_delegation_missing'),
    },
    handler: {
      handle: ({ config, result, state }) => result.status === 'block'
        ? options.onBlock({ state, config, result })
        : null,
    },
  });
}
