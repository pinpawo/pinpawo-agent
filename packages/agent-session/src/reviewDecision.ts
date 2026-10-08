import type {
  HumanReviewPendingInterruptProjection,
  ReviewResponse,
} from './review';

export type PreparedReviewDecision =
  | {
      ok: true;
      decision: ReviewResponse;
      responses: ReviewResponse[];
      shouldSend: boolean;
    }
  | {
      ok: false;
      reason: 'stale' | 'input-required';
    };

/**
 * Add one answer to a review batch, the way every interface does: the
 * server's options decide whether the batch is sent now (`immediate`, or the
 * last interaction) or collected (`defer`). Answers already collected must
 * still match the current interrupt, or the batch is stale.
 */
export function prepareReviewDecision(params: {
  pendingInterrupt: HumanReviewPendingInterruptProjection;
  responses: readonly ReviewResponse[];
  optionId: string;
  inputText?: string;
}): PreparedReviewDecision {
  if (!reviewResponsesRemainValid(params.pendingInterrupt, params.responses)) {
    return { ok: false, reason: 'stale' };
  }

  const interactions = params.pendingInterrupt.payload.interactions;
  const review = interactions[params.responses.length];
  const option = review?.options.find((candidate) => (
    candidate.id === params.optionId
  ));
  if (!review || !option) {
    return { ok: false, reason: 'stale' };
  }

  const inputText = params.inputText?.trim() ?? '';
  if (option.input?.kind === 'text' && !inputText) {
    return { ok: false, reason: 'input-required' };
  }
  const input = option.input?.kind === 'text'
    ? { [option.input.key]: inputText }
    : undefined;
  const decision: ReviewResponse = {
    interactionId: review.interactionId,
    selectedOptionId: option.id,
    ...(input ? { input } : {}),
  };
  const responses = [...params.responses, decision];
  return {
    ok: true,
    decision,
    responses,
    shouldSend: option.batchSubmission === 'immediate'
      || responses.length >= interactions.length,
  };
}

export function reviewResponsesRemainValid(
  pendingInterrupt: HumanReviewPendingInterruptProjection,
  responses: readonly ReviewResponse[],
) {
  const interactions = pendingInterrupt.payload.interactions;
  if (responses.length >= interactions.length) return false;
  return responses.every((decision, index) => {
    const review = interactions[index];
    const option = review?.options.find((candidate) => (
      candidate.id === decision.selectedOptionId
    ));
    return review?.interactionId === decision.interactionId
      && option?.batchSubmission === 'defer';
  });
}
