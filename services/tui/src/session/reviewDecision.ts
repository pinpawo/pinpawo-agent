import type {
  AgentReviewAction,
  ReviewResponse,
} from '@pinpawo/agent-session';

export type PreparedReviewDecision =
  | {
      ok: true;
      decision: ReviewResponse;
      decisions: ReviewResponse[];
      shouldSend: boolean;
    }
  | {
      ok: false;
      reason: 'stale' | 'input-required';
    };

export function prepareReviewDecision(params: {
  action: AgentReviewAction;
  decisions: readonly ReviewResponse[];
  optionId: string;
  inputText?: string;
}): PreparedReviewDecision {
  if (!reviewDecisionsRemainValid(params.action, params.decisions)) {
    return { ok: false, reason: 'stale' };
  }

  const review = params.action.reviews[params.decisions.length];
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
  const decisions = [...params.decisions, decision];
  return {
    ok: true,
    decision,
    decisions,
    shouldSend: option.continuesInteraction !== true
      || decisions.length >= params.action.reviews.length,
  };
}

export function reviewDecisionsRemainValid(
  action: AgentReviewAction,
  decisions: readonly ReviewResponse[],
) {
  if (decisions.length >= action.reviews.length) return false;
  return decisions.every((decision, index) => {
    const review = action.reviews[index];
    const option = review?.options.find((candidate) => (
      candidate.id === decision.selectedOptionId
    ));
    return review?.interactionId === decision.interactionId
      && option?.continuesInteraction === true;
  });
}
