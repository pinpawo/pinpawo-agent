import type {
  CapabilityMessageLane,
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

export function appendRunDelegationSummary(
  runDelegationSummaries: RunDelegationSummary[],
  nextDelegation: RunNextDelegation,
): RunDelegationSummary[] {
  const runDelegation: RunDelegationSummary = {
    id: nextDelegation.id,
    lane: nextDelegation.lane,
    task: nextDelegation.task,
    status: 'pending',
    resultPreview: null,
  };

  return [...runDelegationSummaries, runDelegation];
}

export function resumeRunDelegationSummary(
  runDelegationSummaries: RunDelegationSummary[],
  delegation: RunNextDelegation,
): RunDelegationSummary[] {
  const existing = runDelegationSummaries.some((item) => item.id === delegation.id);
  if (!existing) {
    return appendRunDelegationSummary(runDelegationSummaries, delegation);
  }
  return runDelegationSummaries.map((item) => item.id === delegation.id
    ? {
        ...item,
        lane: delegation.lane,
        task: delegation.task,
        status: 'pending' as const,
        resultPreview: null,
      }
    : item);
}
