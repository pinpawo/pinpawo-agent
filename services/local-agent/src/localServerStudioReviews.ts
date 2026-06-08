import { readFirstHumanReviewDecision, type HumanReviewDecision } from '@pinpawo/pet-agent';
import type { HumanReviewResponseMessage } from './localAgentProtocol';
import {
  createPendingReviewSlot,
  rejectReview,
  resolveReview,
  type PendingReviewSlot,
} from './studio/studioBridge';

type Log = (message: string) => void;

export type StudioReviewConnection = object;

export function decodeStudioReviewDecision(
  msg: Pick<HumanReviewResponseMessage, 'message' | 'resume'>,
): HumanReviewDecision {
  if (msg.resume !== undefined) {
    const decoded = readFirstHumanReviewDecision(msg.resume);
    if (decoded) return decoded;
  }
  const text = (msg.message ?? '').trim();
  if (text) {
    return { type: 'respond', message: text };
  }
  return { type: 'reject' };
}

export class LocalServerStudioReviewRouter<Connection extends StudioReviewConnection = StudioReviewConnection> {
  private readonly pendingReviews = new Map<Connection, PendingReviewSlot>();

  getOrCreateSlot(connection: Connection): PendingReviewSlot {
    let slot = this.pendingReviews.get(connection);
    if (!slot) {
      slot = createPendingReviewSlot();
      this.pendingReviews.set(connection, slot);
    }
    return slot;
  }

  routeResponse(
    connection: Connection,
    msg: HumanReviewResponseMessage,
    log: Log = console.log,
  ) {
    const slot = this.pendingReviews.get(connection);
    if (!slot?.current) {
      return false;
    }
    const decision = decodeStudioReviewDecision(msg);
    log(
      `[local-server] route ${msg.type} as studio HITL answer (reviewId=${slot.current.reviewId}, decision=${decision.type})`,
    );
    resolveReview(slot, decision);
    return true;
  }

  rejectPending(connection: Connection, error: Error) {
    const slot = this.pendingReviews.get(connection);
    return slot ? rejectReview(slot, error) : false;
  }

  rejectAndDelete(connection: Connection, error: Error) {
    const rejected = this.rejectPending(connection, error);
    this.pendingReviews.delete(connection);
    return rejected;
  }
}
