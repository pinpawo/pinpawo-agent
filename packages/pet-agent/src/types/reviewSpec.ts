import { randomUUID } from 'node:crypto';
import type {
  HumanReviewOption,
  HumanReviewOptionInput,
  HumanReviewRequest,
  HumanReviewResponse,
  HumanReviewView,
} from '@pinpawo/agent-contracts';
import {
  HUMAN_REVIEW_REQUEST_SCHEMA_VERSION,
  hasOnlyKeys,
  isJsonObject,
  readNonEmptyString,
} from '@pinpawo/agent-contracts';
import { isReviewSpecValue } from './reviewSpecValidation';

export { isReviewSpecValue };

/** The public review contract owns these shapes; the runtime adds no fields. */
export type ReviewView = HumanReviewView;
export type ReviewOptionInput = HumanReviewOptionInput;

export type ReviewOptionDecision =
  | { type: 'approve' }
  | { type: 'reject'; message?: string }
  | { type: 'respond'; messageInputKey: 'message' };

export type ReviewResolvedDecision =
  | { type: 'approve' }
  | { type: 'reject'; message?: string }
  | { type: 'respond'; message: string };

export type ReviewEffect =
  | {
      type: 'graph.authorize_tool_action';
      scope: 'thread';
    };

/**
 * A runtime review option: the public option without its client-side batch
 * hint, plus the decision and effects that stay inside the runtime.
 */
export type ReviewOption = Omit<HumanReviewOption, 'batchSubmission'> & {
  decision: ReviewOptionDecision;
  effects?: ReviewEffect[];
};

export type ReviewSpec = {
  id: string;
  schemaVersion: number;
  view: ReviewView;
  options: ReviewOption[];
};

export type BuildReviewSpecParams = {
  id?: string;
  schemaVersion?: number;
  view: ReviewView;
  options: ReviewOption[];
};

export function buildReviewSpec(params: BuildReviewSpecParams): ReviewSpec {
  return {
    id: params.id ?? randomUUID(),
    schemaVersion: params.schemaVersion ?? 1,
    view: params.view,
    options: params.options,
  };
}

/**
 * Returns a human-readable text rendering of a review view, for consumers that
 * only need the textual content (LLM review prompts, reject-message appends).
 * The `diff` variant has no `body`, so it is flattened to its summary + patch.
 */
export function reviewViewToText(view: ReviewView): string {
  if (view.kind === 'diff') {
    return [
      view.summary ? `Summary: ${view.summary}` : null,
      view.target ? `Target: ${view.target}` : null,
      view.patch,
    ].filter((line): line is string => Boolean(line)).join('\n\n');
  }
  if (view.kind === 'operation') {
    return [
      view.summary ? `Summary: ${view.summary}` : null,
      view.target ? `Target: ${view.target}` : null,
      view.details ? `Details:\n${JSON.stringify(view.details, null, 2)}` : null,
    ].filter((line): line is string => Boolean(line)).join('\n\n');
  }
  return view.body;
}

/** Appends a trailing message to a review view's textual content. */
export function appendReviewViewMessage(view: ReviewView, message: string): ReviewView {
  if (view.kind === 'diff' || view.kind === 'operation') {
    return {
      kind: 'plain',
      ...(view.title ? { title: view.title } : {}),
      body: `${reviewViewToText(view)}\n\n${message}`,
    };
  }
  return { ...view, body: `${view.body}\n\n${message}` };
}

export type PendingReviewAction = {
  actionId: string;
  toolName: string;
  args: Record<string, unknown>;
  description?: string;
};

export type ReviewResolutionContext = {
  reviewSpec: ReviewSpec;
  pendingAction?: PendingReviewAction;
};

export type HumanReviewInterruptPayload = {
  kind: 'review';
  review: ReviewSpec;
  pendingAction?: PendingReviewAction;
  error?: string;
};

export type HumanReviewBatchInterruptPayload = {
  kind: 'review_batch';
  reviews: HumanReviewInterruptPayload[];
  error?: string;
};

export type HumanReviewInterrupt =
  | HumanReviewInterruptPayload
  | HumanReviewBatchInterruptPayload;

function isPendingReviewActionValue(value: unknown): value is PendingReviewAction {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['actionId', 'toolName', 'args', 'description'])) {
    return false;
  }
  return Boolean(readNonEmptyString(value.actionId))
    && Boolean(readNonEmptyString(value.toolName))
    && isJsonObject(value.args)
    && (value.description === undefined || typeof value.description === 'string');
}

export function isHumanReviewInterruptPayload(value: unknown): value is HumanReviewInterruptPayload {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['kind', 'review', 'pendingAction', 'error'])) {
    return false;
  }
  return value.kind === 'review'
    && isReviewSpecValue(value.review)
    && (value.pendingAction === undefined || isPendingReviewActionValue(value.pendingAction))
    && (value.error === undefined || typeof value.error === 'string');
}

export function isHumanReviewBatchInterruptPayload(
  value: unknown,
): value is HumanReviewBatchInterruptPayload {
  if (!isJsonObject(value) || !hasOnlyKeys(value, ['kind', 'reviews', 'error'])) {
    return false;
  }
  return value.kind === 'review_batch'
    && Array.isArray(value.reviews)
    && value.reviews.length > 0
    && value.reviews.every(isHumanReviewInterruptPayload)
    && (value.error === undefined || typeof value.error === 'string');
}

export function isHumanReviewInterrupt(value: unknown): value is HumanReviewInterrupt {
  return isHumanReviewInterruptPayload(value) || isHumanReviewBatchInterruptPayload(value);
}

export type ReviewResponse = {
  reviewId: string;
  selectedOptionId: string;
  input?: Record<string, unknown>;
};

/**
 * Projects an internal review definition to the transport-neutral interaction
 * boundary. Decisions and effects remain in the runtime's checkpointed review
 * spec and are never delegated to the client for interpretation.
 */
export function projectHumanReviewRequest(review: ReviewSpec): HumanReviewRequest {
  return {
    interactionId: review.id,
    schemaVersion: HUMAN_REVIEW_REQUEST_SCHEMA_VERSION,
    view: review.view,
    options: review.options.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.description !== undefined ? { description: option.description } : {}),
      ...(option.variant !== undefined ? { variant: option.variant } : {}),
      ...(option.input ? { input: option.input } : {}),
      batchSubmission: option.decision.type === 'approve' ? 'defer' : 'immediate',
    })),
  };
}

/** Converts the public interaction response back to the runtime-local form. */
export function toInternalReviewResponse(response: HumanReviewResponse): ReviewResponse {
  return {
    reviewId: response.interactionId,
    selectedOptionId: response.selectedOptionId,
    ...(response.input ? { input: response.input } : {}),
  };
}

export type ReviewBatchResponse = {
  decisions: ReviewResponse[];
};

export type ReviewResponseResolution = {
  reviewId: string;
  optionId: string;
  decision: ReviewResolvedDecision;
  effects: ReviewEffect[];
  display: {
    label: string;
    userInputMessage?: string;
  };
};
