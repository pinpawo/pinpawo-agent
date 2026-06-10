import type { PendingReviewState } from './reviewSpec';

export class ToolReviewRequiredError extends Error {
  readonly pendingReview: PendingReviewState;

  constructor(pendingReview: PendingReviewState) {
    super(`Tool review required: ${pendingReview.reviewSpec.id}`);
    this.name = 'ToolReviewRequiredError';
    this.pendingReview = pendingReview;
    Object.setPrototypeOf(this, ToolReviewRequiredError.prototype);
  }
}

export function isToolReviewRequiredError(error: unknown): error is ToolReviewRequiredError {
  return error instanceof ToolReviewRequiredError;
}
