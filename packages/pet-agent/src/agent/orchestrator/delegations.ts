import type {
  MessageLane,
  RunNextDelegation,
  RunDelegationSummary,
} from './types';
import { clipForPrompt } from './utils';

export function updateRunDelegationSummaryResult(
  runDelegationSummaries: RunDelegationSummary[],
  delegationId: string | null,
  params: {
    status: RunDelegationSummary['status'];
    resultPreview: string | null;
  },
): RunDelegationSummary[] {
  if (!delegationId) return runDelegationSummaries;
  return runDelegationSummaries.map((delegation) => delegation.id === delegationId
    ? {
        ...delegation,
        status: params.status,
        resultPreview: params.resultPreview ? clipForPrompt(params.resultPreview, 320) : null,
      }
    : delegation);
}

export function reuseOrAppendRunDelegationSummary(
  runDelegationSummaries: RunDelegationSummary[],
  nextDelegation: RunNextDelegation | null,
) {
  if (!nextDelegation) {
    return {
      runDelegationSummaries,
      runNextDelegation: null as RunNextDelegation | null,
    };
  }

  // If the same lane already has a delegation in progress, always reuse it.
  const inProgress = runDelegationSummaries.find((delegation) =>
    delegation.lane === nextDelegation.lane && delegation.status === 'progress',
  );
  if (inProgress) {
    return {
      runDelegationSummaries: runDelegationSummaries.map((delegation) => delegation.id === inProgress.id
        ? {
            ...delegation,
            task: nextDelegation.task,
            status: 'pending' as const,
            resultPreview: null,
          }
        : delegation),
      runNextDelegation: {
        ...nextDelegation,
        id: inProgress.id,
      },
    };
  }

  const runDelegation: RunDelegationSummary = {
    id: nextDelegation.id,
    lane: nextDelegation.lane,
    task: nextDelegation.task,
    status: 'pending',
    resultPreview: null,
  };

  return {
    runDelegationSummaries: [...runDelegationSummaries, runDelegation],
    runNextDelegation: nextDelegation,
  };
}
