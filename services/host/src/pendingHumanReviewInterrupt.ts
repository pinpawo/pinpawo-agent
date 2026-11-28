import type { HumanReviewResponse } from '@pinpawo/agent-contracts';
import {
  resolveHumanReviewResponse as resolveHumanReviewDecision,
  ReviewResponseResolutionError,
  toInternalReviewResponse,
  type ReviewResponse,
  type ReviewSpec,
} from '@pinpawo/pet-agent';

/**
 * The review kind's resume values. `decisions` answers the reviews; `cancel`
 * withdraws the proposed action and stops the run. Both arrive through
 * interrupt.resume and are validated here against the authoritative
 * checkpoint before any of them reaches LangGraph.
 */
export type ReviewResumeValue =
  | { decisions: HumanReviewResponse[] }
  | { action: 'cancel' };

export function readReviewResumeValue(value: unknown): ReviewResumeValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.action === 'cancel') {
    return Object.keys(record).length === 1 ? { action: 'cancel' } : null;
  }
  if (!Array.isArray(record.decisions) || Object.keys(record).length !== 1) {
    return null;
  }
  return { decisions: record.decisions as HumanReviewResponse[] };
}

export function readHumanReviewResponses(
  responses: HumanReviewResponse[],
): ReviewResponse[] {
  return responses.map(toInternalReviewResponse);
}

export function validateHumanReviewResponses(
  reviews: readonly ReviewSpec[],
  responses: HumanReviewResponse[],
): ReviewResponse[] {
  const decisions = readHumanReviewResponses(responses);
  if (!decisions.length) {
    throw new ReviewResponseResolutionError(
      'invalid_response',
      'Human review response must include at least one interaction response.',
    );
  }
  if (decisions.length > reviews.length) {
    throw new ReviewResponseResolutionError(
      'invalid_response',
      `Human review response includes ${decisions.length} decisions for ${reviews.length} pending reviews.`,
    );
  }

  for (let index = 0; index < decisions.length; index += 1) {
    const review = reviews[index];
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
        `Human review decision is missing at index ${index}.`,
      );
    }
    if (decision.reviewId !== review.id) {
      throw new ReviewResponseResolutionError(
        'stale_review',
        `Human review decision "${decision.reviewId}" does not match pending review "${review.id}".`,
      );
    }
    const resolution = resolveHumanReviewDecision({ reviewSpec: review }, decision);
    const isFinalDecision = index === decisions.length - 1;
    if (resolution.decision.type !== 'approve' && !isFinalDecision) {
      throw new ReviewResponseResolutionError(
        'invalid_response',
        `Human review decision "${resolution.reviewId}" stops the interrupt and must be final.`,
      );
    }
    if (
      resolution.decision.type === 'approve'
      && isFinalDecision
      && decisions.length < reviews.length
    ) {
      throw new ReviewResponseResolutionError(
        'invalid_response',
        `Human review interrupt is missing decisions after "${resolution.reviewId}".`,
      );
    }
  }
  return decisions;
}

/**
 * The review kind's own resume value. The interrupt id is not folded in here:
 * the Host passes it separately, and the id-keyed LangGraph shape is built at
 * the graph service's adapter boundary.
 */
export function buildHumanReviewResumeValue(decisions: ReviewResponse[]) {
  return { decisions };
}

export function buildHumanReviewCancelResumeValue() {
  return { action: 'interrupt_run' } as const;
}

export type HumanReviewResumeValue =
  | ReturnType<typeof buildHumanReviewResumeValue>
  | ReturnType<typeof buildHumanReviewCancelResumeValue>;

/** What the person decided, for logging. Not a message type. */
export type HumanReviewResolutionSource =
  | {
      type: 'review_decision';
      interactionId: string;
      selectedOptionId: string;
      decisionCount: number;
    }
  | {
      type: 'review_cancel';
      interactionId: string;
      decisionCount: 0;
    };

/** Translate a reply using the review specs for the already matched interrupt. */
export function resolveHumanReviewAnswer(
  reviews: readonly ReviewSpec[],
  value: unknown,
): { resume: HumanReviewResumeValue; source: HumanReviewResolutionSource }
  | { code: 'interrupt_response_invalid' | 'interrupt_stale' | 'interrupt_closed' } {
  const requested = readReviewResumeValue(value);
  if (!requested) return { code: 'interrupt_response_invalid' };

  if ('decisions' in requested) {
    let decisions: ReviewResponse[];
    try {
      decisions = validateHumanReviewResponses(reviews, requested.decisions);
    } catch (error) {
      console.warn('[human-review] response rejected:', error instanceof Error ? error.message : String(error));
      const stale = error instanceof ReviewResponseResolutionError && error.code === 'stale_review';
      return { code: stale ? 'interrupt_stale' : 'interrupt_response_invalid' };
    }
    const finalDecision = decisions.at(-1)!;
    return {
      resume: buildHumanReviewResumeValue(decisions),
      source: {
        type: 'review_decision',
        interactionId: finalDecision.reviewId,
        selectedOptionId: finalDecision.selectedOptionId,
        decisionCount: decisions.length,
      },
    };
  }

  const firstReview = reviews[0];
  if (!firstReview) return { code: 'interrupt_closed' };
  return {
    resume: buildHumanReviewCancelResumeValue(),
    source: {
      type: 'review_cancel',
      interactionId: firstReview.id,
      decisionCount: 0,
    },
  };
}
