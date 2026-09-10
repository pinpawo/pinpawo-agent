import { projectHumanReviewRequest, type PendingInterrupt } from '@pinpawo/pet-agent';
import type { PendingInterruptProjection } from '@pinpawo/agent-session';

/**
 * Project a decoded interrupt onto the wire. Every Host surface announces a
 * pending interrupt through this, so a task pause reaches an interface the
 * same way whether its run came from Chat or from resident dispatch.
 */
export function projectPendingInterrupt(
  pending: PendingInterrupt,
): PendingInterruptProjection {
  return {
    interruptId: pending.interruptId,
    payload: pending.payload.kind === 'human_review'
      ? {
          kind: 'human_review',
          interactions: pending.payload.reviews.map(projectHumanReviewRequest),
        }
      : { kind: 'pause_task' },
  };
}
