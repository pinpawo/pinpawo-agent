import type {
  ReviewEffect,
  ReviewOption,
  ReviewBatchResponse,
  ReviewResponse,
  ReviewResponseResolution,
  ReviewResolutionContext,
} from './reviewSpec';

export type ReviewResponseResolutionErrorCode =
  | 'stale_review'
  | 'unknown_option'
  | 'unexpected_input'
  | 'missing_input'
  | 'invalid_input'
  | 'invalid_effect'
  | 'invalid_response';

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

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyKeys(record: Record<string, unknown>, allowedKeys: readonly string[]) {
  const allowed = new Set(allowedKeys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function readReviewResponse(value: unknown): ReviewResponse | null {
  const record = readRecord(value);
  if (!record) return null;
  if (!hasOnlyKeys(record, ['reviewId', 'selectedOptionId', 'input'])) return null;
  const reviewId = typeof record.reviewId === 'string' && record.reviewId.trim()
    ? record.reviewId.trim()
    : null;
  const selectedOptionId = typeof record.selectedOptionId === 'string' && record.selectedOptionId.trim()
    ? record.selectedOptionId.trim()
    : null;
  const input = readRecord(record.input);
  if (record.input !== undefined && !input) return null;
  return reviewId && selectedOptionId
    ? {
        reviewId,
        selectedOptionId,
        ...(input ? { input } : {}),
      }
    : null;
}

function readReviewBatchResponse(value: unknown): ReviewBatchResponse | null {
  const record = readRecord(value);
  if (!record || !hasOnlyKeys(record, ['decisions'])) return null;
  if (!Array.isArray(record.decisions)) return null;
  const decisions = record.decisions.map(readReviewResponse);
  if (decisions.some((decision) => !decision)) return null;
  return {
    decisions: decisions as ReviewResponse[],
  };
}

function hasCanonicalReviewResponseFields(value: unknown) {
  const record = readRecord(value);
  return Boolean(
    record
      && (
        Object.prototype.hasOwnProperty.call(record, 'reviewId')
        || Object.prototype.hasOwnProperty.call(record, 'selectedOptionId')
        || Object.prototype.hasOwnProperty.call(record, 'input')
      ),
  );
}

function hasCanonicalReviewBatchResponseFields(value: unknown) {
  const record = readRecord(value);
  return Boolean(
    record
      && Object.prototype.hasOwnProperty.call(record, 'decisions'),
  );
}

export function resolveHumanReviewResponse(
  pendingReview: ReviewResolutionContext,
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

export function resolveHumanReviewBatchResponse(
  pendingReviews: ReviewResolutionContext[],
  response: ReviewBatchResponse,
): ReviewResponseResolution[] {
  if (response.decisions.length === 0) {
    throw new ReviewResponseResolutionError(
      'invalid_response',
      'Review batch response must include at least one decision.',
    );
  }
  if (response.decisions.length > pendingReviews.length) {
    throw new ReviewResponseResolutionError(
      'invalid_response',
      `Review batch response included ${response.decisions.length} decisions for ${pendingReviews.length} pending reviews.`,
    );
  }
  return response.decisions.map((decision, index) => {
    const pendingReview = pendingReviews[index];
    if (!pendingReview) {
      throw new ReviewResponseResolutionError(
        'invalid_response',
        `Review batch decision "${decision.reviewId}" has no matching pending review.`,
      );
    }
    if (decision.reviewId !== pendingReview.reviewSpec.id) {
      throw new ReviewResponseResolutionError(
        'stale_review',
        `Review batch decision "${decision.reviewId}" does not match pending review "${pendingReview.reviewSpec.id}".`,
      );
    }
    return resolveHumanReviewResponse(pendingReview, decision);
  });
}

export function resolveHumanReviewResume(
  pendingReview: ReviewResolutionContext,
  resume: unknown,
): ReviewResponseResolution {
  const response = readReviewResponse(resume);
  if (response) {
    return resolveHumanReviewResponse(pendingReview, response);
  }

  throw new ReviewResponseResolutionError(
    'invalid_response',
    hasCanonicalReviewResponseFields(resume)
      ? `Review resume for pending review "${pendingReview.reviewSpec.id}" is an invalid canonical response.`
      : `Review resume for pending review "${pendingReview.reviewSpec.id}" is not a canonical response.`,
  );
}

// Only the batch shape `{ decisions: [...] }` is accepted. The legacy single
// response shape `{ reviewId, selectedOptionId }` is deprecated: it fails here
// and drives the middleware's invalid-decision re-interrupt loop. All
// first-party clients (TUI, local server, app chat handler) already send the
// batch shape, so this path is only reached by out-of-date clients.
export function resolveHumanReviewBatchResume(
  pendingReviews: ReviewResolutionContext[],
  resume: unknown,
): ReviewResponseResolution[] {
  const response = readReviewBatchResponse(resume);
  if (response) {
    return resolveHumanReviewBatchResponse(pendingReviews, response);
  }

  throw new ReviewResponseResolutionError(
    'invalid_response',
    hasCanonicalReviewBatchResponseFields(resume)
      ? 'Review batch resume is an invalid canonical response.'
      : 'Review batch resume is not a canonical response.',
  );
}
