import { projectHumanReviewRequest, type PendingInterrupt } from '@pinpawo/pet-agent';
import type { PendingInterruptProjection } from '@pinpawo/agent-session';

/** Project a native human review onto the shared read-only wire projection. */
export function projectPendingInterrupt(pending: PendingInterrupt): PendingInterruptProjection {
  return {
    interruptId: pending.interruptId,
    payload: {
      kind: 'human_review',
      interactions: pending.payload.reviews.map(projectHumanReviewRequest),
    },
  };
}
