import {
  readFirstHumanReviewDecision,
  resolveHumanReviewResponse,
  ReviewResponseResolutionError,
  type HumanReviewDecision,
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

export function decodeLegacyStudioReviewDecision(
  msg: Pick<HumanReviewResponseMessage, 'resume'>,
): HumanReviewDecision | null {
  if (msg.resume !== undefined) {
    const decoded = readFirstHumanReviewDecision(msg.resume);
    if (decoded) return decoded;
  }
  return null;
}

function resolveStudioReviewDecision(
  pending: PendingReview,
  msg: HumanReviewResponseMessage,
): HumanReviewDecision | null {
  if (msg.reviewId && msg.selectedOptionId) {
    const resolution = resolveHumanReviewResponse({
      requestId: msg.requestId,
      reviewSpec: pending.reviewSpec,
      pendingAction: {
        actionId: 'studio_review',
        toolName: 'studio_review',
        args: {},
      },
    }, {
      reviewId: msg.reviewId,
      selectedOptionId: msg.selectedOptionId,
      ...(msg.input ? { input: msg.input } : {}),
    });
    return resolution.decision;
  }

  return decodeLegacyStudioReviewDecision(msg);
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
    let decision: HumanReviewDecision | null = null;
    try {
      decision = resolveStudioReviewDecision(slot.current, msg);
    } catch (err) {
      if (err instanceof ReviewResponseResolutionError) {
        log(
          `[local-server] rejected studio HITL answer (reviewId=${slot.current.reviewId}, code=${err.code})`,
        );
        return true;
      }
      throw err;
    }
    if (!decision) {
      log(
        `[local-server] rejected studio HITL answer (reviewId=${slot.current.reviewId}, reason=missing_decision)`,
      );
      return true;
    }
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
