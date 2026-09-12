import { readPendingInterrupt, type PendingInterrupt } from './readPendingInterrupt';

export type AbortSettlementGraph = {
  getState: () => Promise<unknown>;
};

/**
 * Preserve actual interrupts. Cancellation itself is not a native interrupt:
 * leave committed facts intact and let the next user run enter Entry Answer.
 * Never turn an unreturned execution into a synthetic resumable success.
 *
 * The result is the interrupt domain's own type rather than a parallel status
 * union: an interrupt that was already pending, or nothing. A returned
 * interrupt is reported as `waiting` and published on the same
 * `interrupt.requested` chain as any other; `null` means the cancelled run
 * reports `interrupted`.
 */
export async function settleAbortedRun(
  graph: AbortSettlementGraph,
): Promise<PendingInterrupt | null> {
  return readPendingInterrupt(await graph.getState());
}
