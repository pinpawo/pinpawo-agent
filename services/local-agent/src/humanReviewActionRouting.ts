import {
  resolveHumanReviewResponse,
  ReviewResponseResolutionError,
  type ReviewResponse,
  type ReviewSpec,
} from '@pinpawo/pet-agent';
import type { HumanReviewResponseMessage } from './localAgentProtocol';
import type { ReviewAction } from './reviewAction';

export type HumanReviewActionRoute = ReviewAction & {
  interruptId?: string;
};

export function matchesHumanReviewAction(
  route: HumanReviewActionRoute,
  actionId: string | undefined,
) {
  return !actionId || actionId === route.actionId;
}

export function readHumanReviewDecisions(msg: HumanReviewResponseMessage): ReviewResponse[] {
  return msg.decisions ?? [{
    reviewId: msg.reviewId,
    selectedOptionId: msg.selectedOptionId,
    ...(msg.input ? { input: msg.input } : {}),
  }];
}

export function validateHumanReviewDecisions(
  route: HumanReviewActionRoute,
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
function buildRejectAllDecisions(route: HumanReviewActionRoute): ReviewResponse[] {
  return route.reviews.map((review) => ({
    reviewId: review.id,
    selectedOptionId: readRejectOptionId(review),
  }));
}

export function buildHumanReviewResume(
  route: HumanReviewActionRoute,
  decisions: ReviewResponse[],
) {
  if (route.interruptId) {
    return { [route.interruptId]: { decisions } };
  }
  // LangGraph always stamps an id on a real interrupt, so a missing interruptId
  // means this is not a resumable pending review action. Resuming by value would
  // risk delivering the decisions to the wrong interrupt, so fail closed: record
  // the anomaly and reject the whole review action instead of guessing.
  console.warn(
    `[human-review] missing interruptId for review action=${route.reviews.map((review) => review.id).join(',')}; `
    + 'rejecting all pending reviews',
  );
  return { decisions: buildRejectAllDecisions(route) };
}

export function buildHumanReviewRejectResume(
  route: HumanReviewActionRoute,
  rejectOptionId: string,
) {
  const firstReview = route.reviews[0];
  if (!firstReview) {
    throw new ReviewResponseResolutionError(
      'invalid_response',
      `Review action "${route.actionId}" has no reviews to cancel.`,
    );
  }
  return buildHumanReviewResume(route, [{
    reviewId: firstReview.id,
    selectedOptionId: rejectOptionId,
  }]);
}
