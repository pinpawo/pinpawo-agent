import type { ReviewResponse, ReviewSpec } from '@pinpawo/pet-agent';

export type ReviewAction = {
  actionId: string;
  reviews: ReviewSpec[];
};

export type ReviewDraft = {
  actionId: string;
  decisions: ReviewResponse[];
  resolution?: 'submitting' | 'canceling';
};

export function reviewActionId(params: {
  requestId: string;
  interruptId?: string;
  reviews?: ReviewSpec[];
}) {
  if (params.interruptId) return params.interruptId;
  const reviewKey = params.reviews?.length
    ? params.reviews.map((review) => encodeURIComponent(review.id)).join(',')
    : 'unknown';
  return `request:${params.requestId}:reviews:${reviewKey}`;
}

export function reviewActionReviews(
  review: ReviewSpec,
  reviews?: ReviewSpec[],
) {
  return reviews?.length ? reviews : [review];
}

export function currentReview(
  action: ReviewAction,
  draft: ReviewDraft,
) {
  if (action.actionId !== draft.actionId) return undefined;
  return action.reviews[draft.decisions.length];
}
