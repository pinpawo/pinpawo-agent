import {
  resolveHumanReviewResponse,
  ReviewResponseResolutionError,
  type ReviewResponse,
  type ReviewSpec,
} from '@pinpawo/pet-agent';
import type { HumanReviewResponseMessage } from './localAgentProtocol';

export type PendingHumanReviewActionRoute = {
  interruptId?: string;
  reviewId: string;
  reviews: ReviewSpec[];
};

export function readHumanReviewDecisions(msg: HumanReviewResponseMessage): ReviewResponse[] {
  return msg.decisions ?? [{
    reviewId: msg.reviewId,
    selectedOptionId: msg.selectedOptionId,
    ...(msg.input ? { input: msg.input } : {}),
  }];
}

export function validateHumanReviewDecisions(
  route: PendingHumanReviewActionRoute,
  msg: HumanReviewResponseMessage,
): ReviewResponse[] {
  const decisions = readHumanReviewDecisions(msg);
  const finalDecision = decisions.at(-1);
  if (
    !finalDecision
    || finalDecision.reviewId !== msg.reviewId
    || finalDecision.selectedOptionId !== msg.selectedOptionId
  ) {
    throw new ReviewResponseResolutionError(
      'stale_review',
      'Human review response must identify its final review action decision.',
    );
  }
  if (decisions.length > route.reviews.length) {
    throw new ReviewResponseResolutionError(
      'invalid_response',
      `Human review response includes ${decisions.length} decisions for ${route.reviews.length} pending reviews.`,
    );
  }

  for (let index = 0; index < decisions.length; index += 1) {
    const review = route.reviews[index];
    const decision = decisions[index];
    if (!review) {
      throw new ReviewResponseResolutionError(
        'invalid_response',
        `Human review decision "${decisions[index]?.reviewId ?? ''}" has no matching pending review.`,
      );
    }
    if (!decision) {
      throw new ReviewResponseResolutionError(
        'invalid_response',
        `Human review decision is missing for route step ${index}.`,
      );
    }
    if (decision.reviewId !== review.id) {
      throw new ReviewResponseResolutionError(
        'stale_review',
        `Human review decision "${decision.reviewId}" does not match pending review "${review.id}".`,
      );
    }
    const resolution = resolveHumanReviewResponse({ reviewSpec: review }, decision);
    const isFinalDecision = index === decisions.length - 1;
    if (resolution.decision.type !== 'approve' && !isFinalDecision) {
      throw new ReviewResponseResolutionError(
        'invalid_response',
        `Human review decision "${resolution.reviewId}" stops the review action and must be final.`,
      );
    }
    if (
      resolution.decision.type === 'approve'
      && isFinalDecision
      && decisions.length < route.reviews.length
    ) {
      throw new ReviewResponseResolutionError(
        'invalid_response',
        `Human review action is missing decisions after "${resolution.reviewId}".`,
      );
    }
  }
  return decisions;
}

function readRejectOptionId(review: ReviewSpec): string {
  const rejectOption = review.options.find((option) => option.decision.type === 'reject');
  if (rejectOption) return rejectOption.id;
  // No explicit reject option: fall back to the first non-approve option so the
  // decision still stops the review action on the pet-agent side.
  const nonApproveOption = review.options.find((option) => option.decision.type !== 'approve');
  if (nonApproveOption) return nonApproveOption.id;
  throw new ReviewResponseResolutionError(
    'invalid_response',
    `Review "${review.id}" has no option that can reject the review action.`,
  );
}

// Fail-closed resume: reject every pending review in the action. Used when we
// cannot safely map decisions to a specific interrupt (missing interruptId).
function buildRejectAllDecisions(route: PendingHumanReviewActionRoute): ReviewResponse[] {
  return route.reviews.map((review) => ({
    reviewId: review.id,
    selectedOptionId: readRejectOptionId(review),
  }));
}

export function buildHumanReviewResume(
  route: PendingHumanReviewActionRoute,
  decisions: ReviewResponse[],
) {
  if (route.interruptId) {
    return { [route.interruptId]: { decisions } };
  }
  // No interruptId: LangGraph always stamps one on a real interrupt, so a
  // missing id means the pending review action is not the single, unambiguous
  // interrupt we can safely resume by value. A bare resume is only well-defined
  // when exactly one review is pending; anything more could be misrouted to the
  // wrong interrupt. Fail closed there: record the anomaly and reject the whole
  // review action instead of silently approving into the wrong slot.
  if (route.reviews.length > 1) {
    console.warn(
      `[human-review] missing interruptId for multi-review action=${route.reviews.map((review) => review.id).join(',')}; `
      + 'rejecting all pending reviews',
    );
    return { decisions: buildRejectAllDecisions(route) };
  }
  return { decisions };
}

export function buildHumanReviewRejectResume(
  route: PendingHumanReviewActionRoute,
  rejectOptionId: string,
) {
  return buildHumanReviewResume(route, [{
    reviewId: route.reviewId,
    selectedOptionId: rejectOptionId,
  }]);
}
