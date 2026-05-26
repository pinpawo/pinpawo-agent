import type {
  MessageLane,
  PendingDelegation,
  TurnDelegation,
} from './types';
import { clipForPrompt } from './utils';

export function updateTurnDelegationResult(
  turnDelegations: TurnDelegation[],
  delegationId: string | null,
  params: {
    status: TurnDelegation['status'];
    resultPreview: string | null;
  },
): TurnDelegation[] {
  if (!delegationId) return turnDelegations;
  return turnDelegations.map((delegation) => delegation.id === delegationId
    ? {
        ...delegation,
        status: params.status,
        resultPreview: params.resultPreview ? clipForPrompt(params.resultPreview, 320) : null,
      }
    : delegation);
}

export function reuseOrAppendTurnDelegation(
  turnDelegations: TurnDelegation[],
  nextDelegation: PendingDelegation | null,
) {
  if (!nextDelegation) {
    return {
      turnDelegations,
      pendingDelegation: null as PendingDelegation | null,
    };
  }

  // If the same lane already has a delegation in progress, always reuse it.
  const inProgress = turnDelegations.find((delegation) =>
    delegation.lane === nextDelegation.lane && delegation.status === 'progress',
  );
  if (inProgress) {
    return {
      turnDelegations: turnDelegations.map((delegation) => delegation.id === inProgress.id
        ? {
            ...delegation,
            task: nextDelegation.task,
            status: 'pending' as const,
            resultPreview: null,
          }
        : delegation),
      pendingDelegation: {
        ...nextDelegation,
        id: inProgress.id,
      },
    };
  }

  const turnDelegation: TurnDelegation = {
    id: nextDelegation.id,
    lane: nextDelegation.lane,
    task: nextDelegation.task,
    status: 'pending',
    resultPreview: null,
  };

  return {
    turnDelegations: [...turnDelegations, turnDelegation],
    pendingDelegation: nextDelegation,
  };
}
