import type {
  HumanReviewOption,
  HumanReviewOptionInput,
  HumanReviewRequest,
  HumanReviewResponse,
  HumanReviewView,
} from '@pinpawo/agent-contracts';

export type {
  HumanReviewRequest,
  HumanReviewResponse,
} from '@pinpawo/agent-contracts';

export type ReviewSpec = HumanReviewRequest;
export type ReviewOption = HumanReviewOption;
export type ReviewOptionInput = HumanReviewOptionInput;
export type ReviewResponse = HumanReviewResponse;
export type ReviewView = HumanReviewView;

export type ReviewAction = {
  actionId: string;
  reviews: HumanReviewRequest[];
};

export function reviewActionId(params: {
  requestId: string;
  interruptId?: string;
  reviews?: HumanReviewRequest[];
}) {
  if (params.interruptId) return params.interruptId;
  const reviewKey = params.reviews?.length
    ? params.reviews.map((review) => encodeURIComponent(review.interactionId)).join(',')
    : 'unknown';
  return `request:${params.requestId}:reviews:${reviewKey}`;
}

export function reviewActionReviews(
  review: HumanReviewRequest,
  reviews?: HumanReviewRequest[],
) {
  return reviews?.length ? reviews : [review];
}
