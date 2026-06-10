import type {
  PendingReviewState,
  ReviewEffect,
  ReviewOption,
  ReviewResponse,
  ReviewResponseResolution,
} from './reviewSpec';
import { readFirstHumanReviewDecision } from '../humanReview';

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

function readReviewResponse(value: unknown): ReviewResponse | null {
  const record = readRecord(value);
  if (!record) return null;
  const reviewId = typeof record.reviewId === 'string' && record.reviewId.trim()
    ? record.reviewId.trim()
    : null;
  const selectedOptionId = typeof record.selectedOptionId === 'string' && record.selectedOptionId.trim()
    ? record.selectedOptionId.trim()
    : null;
  const input = readRecord(record.input);
  return reviewId && selectedOptionId
    ? {
        reviewId,
        selectedOptionId,
        ...(input ? { input } : {}),
      }
    : null;
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

function formatLegacyDecisionLabel(decision: ReviewResponseResolution['decision']) {
  if (decision.type === 'approve') return 'Approve';
  if (decision.type === 'reject') return decision.message ?? 'Reject';
  if (decision.type === 'edit') return 'Edit';
  return decision.message;
}

export function resolveHumanReviewResume(
  pendingReview: PendingReviewState,
  resume: unknown,
): ReviewResponseResolution {
  const response = readReviewResponse(resume);
  if (response) {
    return resolveHumanReviewResponse(pendingReview, response);
  }

  if (hasCanonicalReviewResponseFields(resume)) {
    throw new ReviewResponseResolutionError(
      'invalid_response',
      `Review resume for pending review "${pendingReview.reviewSpec.id}" is an invalid canonical response.`,
    );
  }

  const decision = readFirstHumanReviewDecision(resume);
  if (!decision) {
    throw new ReviewResponseResolutionError(
      'invalid_response',
      `Review resume for pending review "${pendingReview.reviewSpec.id}" is not a canonical response or legacy decision.`,
    );
  }
  if (decision.type === 'edit') {
    return {
      reviewId: pendingReview.reviewSpec.id,
      optionId: 'legacy.edit',
      decision,
      effects: [],
      display: {
        label: 'Edit',
      },
    };
  }
  return {
    reviewId: pendingReview.reviewSpec.id,
    optionId: `legacy.${decision.type}`,
    decision,
    effects: [],
    display: {
      label: formatLegacyDecisionLabel(decision),
      ...(decision.type === 'respond' ? { userInputMessage: decision.message } : {}),
    },
  };
}
