import {
  resolveHumanReviewResponse,
  ReviewResponseResolutionError,
  type ReviewResponse,
} from '@pinpawo/pet-agent';
import type { HumanReviewResponseMessage } from './localAgentProtocol';
import {
  createPendingReviewSlot,
  type PendingReview,
  rejectReview,
  resolveReview,
  type PendingReviewSlot,
} from './studio/studioBridge';

type Log = (message: string) => void;

export type StudioReviewConnection = object;

function resolveStudioReviewResponse(
  pending: PendingReview,
  msg: HumanReviewResponseMessage,
): ReviewResponse | null {
  if (msg.reviewId && msg.selectedOptionId) {
    const response = {
      reviewId: msg.reviewId,
      selectedOptionId: msg.selectedOptionId,
      ...(msg.input ? { input: msg.input } : {}),
    };
    resolveHumanReviewResponse({
      requestId: msg.requestId,
      reviewSpec: pending.reviewSpec,
      pendingAction: {
        actionId: 'studio_review',
        toolName: 'studio_review',
        args: {},
      },
    }, response);
    return response;
  }

  return null;
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
    let response: ReviewResponse | null = null;
    try {
      response = resolveStudioReviewResponse(slot.current, msg);
    } catch (err) {
      if (err instanceof ReviewResponseResolutionError) {
        log(
          `[local-server] rejected studio HITL answer (reviewId=${slot.current.reviewId}, code=${err.code})`,
        );
        return true;
      }
      throw err;
    }
    if (!response) {
      log(
        `[local-server] rejected studio HITL answer (reviewId=${slot.current.reviewId}, reason=missing_decision)`,
      );
      return true;
    }
    log(
      `[local-server] route ${msg.type} as studio HITL answer (reviewId=${slot.current.reviewId}, option=${response.selectedOptionId})`,
    );
    resolveReview(slot, response);
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
