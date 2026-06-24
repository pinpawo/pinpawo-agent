import type {
  MessageLane,
  RunPendingDelegation,
  RunDelegation,
} from './types';
import { clipForPrompt } from './utils';

export function updateRunDelegationResult(
  runDelegations: RunDelegation[],
  delegationId: string | null,
  params: {
    status: RunDelegation['status'];
    resultPreview: string | null;
  },
): RunDelegation[] {
  if (!delegationId) return runDelegations;
  return runDelegations.map((delegation) => delegation.id === delegationId
    ? {
        ...delegation,
        status: params.status,
        resultPreview: params.resultPreview ? clipForPrompt(params.resultPreview, 320) : null,
      }
    : delegation);
}

export function reuseOrAppendRunDelegation(
  runDelegations: RunDelegation[],
  nextDelegation: RunPendingDelegation | null,
) {
  if (!nextDelegation) {
    return {
      runDelegations,
      runPendingDelegation: null as RunPendingDelegation | null,
    };
  }

  // If the same lane already has a delegation in progress, always reuse it.
  const inProgress = runDelegations.find((delegation) =>
    delegation.lane === nextDelegation.lane && delegation.status === 'progress',
  );
  if (inProgress) {
    return {
      runDelegations: runDelegations.map((delegation) => delegation.id === inProgress.id
        ? {
            ...delegation,
            task: nextDelegation.task,
            status: 'pending' as const,
            resultPreview: null,
          }
        : delegation),
      runPendingDelegation: {
        ...nextDelegation,
        id: inProgress.id,
      },
    };
  }

  const runDelegation: RunDelegation = {
    id: nextDelegation.id,
    lane: nextDelegation.lane,
    task: nextDelegation.task,
    status: 'pending',
    resultPreview: null,
  };

  return {
    runDelegations: [...runDelegations, runDelegation],
    runPendingDelegation: nextDelegation,
  };
}
