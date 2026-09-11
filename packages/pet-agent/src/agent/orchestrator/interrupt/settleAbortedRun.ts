import { readPendingInterrupt, type PendingInterrupt } from './readPendingInterrupt';

export type AbortSettlementGraph = {
  getState: () => Promise<unknown>;
};

export type AbortSettlement =
  | { status: 'paused'; pendingInterrupt: PendingInterrupt }
  | { status: 'finished' };

/**
 * Preserve actual interrupts. Cancellation itself is not a native interrupt:
 * leave committed facts intact and let the next user run enter Entry Answer.
 * Never turn an unreturned execution into a synthetic resumable success.
 */
export async function settleAbortedRun(graph: AbortSettlementGraph): Promise<AbortSettlement> {
  const existing = readPendingInterrupt(await graph.getState());
  return existing ? { status: 'paused', pendingInterrupt: existing } : { status: 'finished' };
}
