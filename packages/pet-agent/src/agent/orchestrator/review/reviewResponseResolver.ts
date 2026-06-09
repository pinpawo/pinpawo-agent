import type {
  PendingReviewState,
  ReviewEffect,
  ReviewOption,
  ReviewResponse,
  ReviewResponseResolution,
} from './reviewSpec';

export type ReviewResponseResolutionErrorCode =
  | 'stale_review'
  | 'unknown_option'
  | 'unexpected_input'
  | 'missing_input'
  | 'invalid_input'
  | 'invalid_effect';

export class ReviewResponseResolutionError extends Error {
  readonly code: ReviewResponseResolutionErrorCode;

  constructor(code: ReviewResponseResolutionErrorCode, message: string) {
    super(message);
    this.name = 'ReviewResponseResolutionError';
    this.code = code;
  }
}

function listInputKeys(input: Record<string, unknown> | undefined) {
  return input ? Object.keys(input) : [];
}

function assertExpectedInputKeys(option: ReviewOption, input: Record<string, unknown> | undefined) {
  const keys = listInputKeys(input);
  const allowedKeys = option.input ? new Set([option.input.key]) : new Set<string>();
  const unexpected = keys.filter((key) => !allowedKeys.has(key));

  if (unexpected.length > 0) {
    throw new ReviewResponseResolutionError(
      'unexpected_input',
      `Review option "${option.id}" does not accept input key "${unexpected[0]}".`,
    );
  }
}

function readRequiredTextInput(
  option: ReviewOption,
  input: Record<string, unknown> | undefined,
  key: string,
) {
  const raw = input?.[key];
  if (typeof raw !== 'string') {
    throw new ReviewResponseResolutionError(
      'missing_input',
      `Review option "${option.id}" requires text input "${key}".`,
    );
  }
  const value = raw.trim();
  if (!value) {
    throw new ReviewResponseResolutionError(
      'missing_input',
      `Review option "${option.id}" requires non-empty text input "${key}".`,
    );
  }
  return value;
}

function validateEffects(option: ReviewOption, effects: ReviewEffect[]) {
  if (
    effects.some((effect) => effect.type === 'graph.authorize_tool_action')
    && option.decision.type !== 'approve'
  ) {
    throw new ReviewResponseResolutionError(
      'invalid_effect',
      `Review option "${option.id}" cannot apply authorization effects without an approve decision.`,
    );
  }
}

export function resolveHumanReviewResponse(
  pendingReview: PendingReviewState,
  response: ReviewResponse,
): ReviewResponseResolution {
  if (response.reviewId !== pendingReview.reviewSpec.id) {
    throw new ReviewResponseResolutionError(
      'stale_review',
      `Review response "${response.reviewId}" does not match pending review "${pendingReview.reviewSpec.id}".`,
    );
  }

  const option = pendingReview.reviewSpec.options.find(
    (item) => item.id === response.selectedOptionId,
  );
  if (!option) {
    throw new ReviewResponseResolutionError(
      'unknown_option',
      `Review option "${response.selectedOptionId}" is not declared by pending review "${pendingReview.reviewSpec.id}".`,
    );
  }

  assertExpectedInputKeys(option, response.input);

  const effects = option.effects ?? [];
  validateEffects(option, effects);

  if (option.decision.type === 'respond') {
    const message = readRequiredTextInput(
      option,
      response.input,
      option.decision.messageInputKey,
    );
    return {
      reviewId: pendingReview.reviewSpec.id,
      optionId: option.id,
      decision: { type: 'respond', message },
      effects,
      display: {
        label: option.label,
        userInputMessage: message,
      },
    };
  }

  return {
    reviewId: pendingReview.reviewSpec.id,
    optionId: option.id,
    decision: option.decision,
    effects,
    display: {
      label: option.label,
    },
  };
}
