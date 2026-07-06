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
    if (!review) {
      throw new ReviewResponseResolutionError(
        'invalid_response',
        `Human review decision "${decisions[index]!.reviewId}" has no matching pending review.`,
      );
    }
    const resolution = resolveHumanReviewResponse({ reviewSpec: review }, decisions[index]!);
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

export function buildHumanReviewResume(
  route: PendingHumanReviewActionRoute,
  decisions: ReviewResponse[],
) {
  const resume = { decisions };
  return route.interruptId ? { [route.interruptId]: resume } : resume;
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

export function readHumanReviewDecisionCount(
  route: PendingHumanReviewActionRoute,
  decisions: ReviewResponse[],
) {
  return decisions.length;
}
