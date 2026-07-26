import { randomUUID } from 'node:crypto';
import { isReviewSpecValue } from './reviewSpecValidation';

export { isReviewSpecValue };

export type ReviewView =
  | { kind: 'plain'; title?: string; body: string }
  | { kind: 'markdown'; title?: string; body: string }
  | { kind: 'diff'; title?: string; patch: string; target?: string; summary?: string };

export type ReviewOptionInput =
  | {
      kind: 'text';
      key: 'message';
      label?: string;
      placeholder?: string;
      required?: boolean;
      multiline?: boolean;
    };

export type ReviewOptionDecision =
  | { type: 'approve' }
  | { type: 'reject'; message?: string }
  | { type: 'respond'; messageInputKey: 'message' };

export type ReviewResolvedDecision =
  | { type: 'approve' }
  | { type: 'reject'; message?: string }
  | { type: 'respond'; message: string };

export type ReviewActionRef =
  | { type: 'pending_action' };

export type ToolAuthorizationMatcherTemplate =
  | { type: 'policy_hook' }
  | { type: 'shell_pattern'; source: 'args.command' }
  | { type: 'exact_args'; source: 'action.args' }
  | { type: 'url_domain'; source: 'args.url' };

export type ToolAuthorizationMatcher =
  | { type: 'exact_args'; value: Record<string, unknown> }
  | { type: 'shell_pattern'; value: string }
  | { type: 'url_domain'; value: { origin: string } };

export type ReviewEffect =
  | {
      type: 'graph.authorize_tool_action';
      scope: 'thread';
      actionRef: ReviewActionRef;
      matcher: ToolAuthorizationMatcherTemplate;
    };

export type ReviewOption = {
  id: string;
  label: string;
  description?: string;
  variant?: 'primary' | 'normal' | 'danger';
  input?: ReviewOptionInput;
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

function readRecordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hasOnlyKeys(record: Record<string, unknown>, allowedKeys: readonly string[]) {
  const allowed = new Set(allowedKeys);
  return Object.keys(record).every((key) => allowed.has(key));
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
  return view.body;
}

/** Appends a trailing message to a review view's textual content. */
export function appendReviewViewMessage(view: ReviewView, message: string): ReviewView {
  if (view.kind === 'diff') {
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
  const record = readRecordValue(value);
  if (!record || !hasOnlyKeys(record, ['actionId', 'toolName', 'args', 'description'])) {
    return false;
  }
  return Boolean(readNonEmptyString(record.actionId))
    && Boolean(readNonEmptyString(record.toolName))
    && Boolean(readRecordValue(record.args))
    && (record.description === undefined || typeof record.description === 'string');
}

export function isHumanReviewInterruptPayload(value: unknown): value is HumanReviewInterruptPayload {
  const record = readRecordValue(value);
  if (!record || !hasOnlyKeys(record, ['kind', 'review', 'pendingAction', 'error'])) {
    return false;
  }
  return record.kind === 'review'
    && isReviewSpecValue(record.review)
    && (record.pendingAction === undefined || isPendingReviewActionValue(record.pendingAction))
    && (record.error === undefined || typeof record.error === 'string');
}

export function isHumanReviewBatchInterruptPayload(
  value: unknown,
): value is HumanReviewBatchInterruptPayload {
  const record = readRecordValue(value);
  if (!record || !hasOnlyKeys(record, ['kind', 'reviews', 'error'])) {
    return false;
  }
  return record.kind === 'review_batch'
    && Array.isArray(record.reviews)
    && record.reviews.length > 0
    && record.reviews.every(isHumanReviewInterruptPayload)
    && (record.error === undefined || typeof record.error === 'string');
}

export function isHumanReviewInterrupt(value: unknown): value is HumanReviewInterrupt {
  return isHumanReviewInterruptPayload(value) || isHumanReviewBatchInterruptPayload(value);
}

export type ReviewResponse = {
  reviewId: string;
  selectedOptionId: string;
  input?: Record<string, unknown>;
};

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
