import { randomUUID } from 'node:crypto';

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

function isReviewViewValue(value: unknown): value is ReviewView {
  const record = readRecordValue(value);
  if (!record) return false;
  const hasValidTitle = record.title === undefined || typeof record.title === 'string';
  if (record.kind === 'plain' || record.kind === 'markdown') {
    return hasOnlyKeys(record, ['kind', 'title', 'body'])
      && typeof record.body === 'string'
      && hasValidTitle;
  }
  if (record.kind === 'diff') {
    return hasOnlyKeys(record, ['kind', 'title', 'patch', 'target', 'summary'])
      && typeof record.patch === 'string'
      && hasValidTitle
      && (record.target === undefined || typeof record.target === 'string')
      && (record.summary === undefined || typeof record.summary === 'string');
  }
  return false;
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

function isReviewOptionInputValue(value: unknown): value is ReviewOptionInput {
  const record = readRecordValue(value);
  if (
    !record
    || !hasOnlyKeys(record, ['kind', 'key', 'label', 'placeholder', 'required', 'multiline'])
  ) {
    return false;
  }
  return record.kind === 'text'
    && record.key === 'message'
    && (record.label === undefined || typeof record.label === 'string')
    && (record.placeholder === undefined || typeof record.placeholder === 'string')
    && (record.required === undefined || typeof record.required === 'boolean')
    && (record.multiline === undefined || typeof record.multiline === 'boolean');
}

function isReviewOptionDecisionValue(value: unknown): value is ReviewOptionDecision {
  const record = readRecordValue(value);
  if (!record) return false;
  if (record.type === 'approve') {
    return hasOnlyKeys(record, ['type']);
  }
  if (record.type === 'reject') {
    return hasOnlyKeys(record, ['type', 'message'])
      && (record.message === undefined || typeof record.message === 'string');
  }
  if (record.type === 'respond') {
    return hasOnlyKeys(record, ['type', 'messageInputKey'])
      && record.messageInputKey === 'message';
  }
  return false;
}

function isToolAuthorizationMatcherTemplateValue(
  value: unknown,
): value is ToolAuthorizationMatcherTemplate {
  const record = readRecordValue(value);
  if (!record) return false;
  if (record.type === 'policy_hook') {
    return hasOnlyKeys(record, ['type']);
  }
  if (record.type === 'shell_pattern') {
    return hasOnlyKeys(record, ['type', 'source'])
      && record.source === 'args.command';
  }
  if (record.type === 'exact_args') {
    return hasOnlyKeys(record, ['type', 'source'])
      && record.source === 'action.args';
  }
  if (record.type === 'url_domain') {
    return hasOnlyKeys(record, ['type', 'source'])
      && record.source === 'args.url';
  }
  return false;
}

function isReviewEffectValue(value: unknown): value is ReviewEffect {
  const record = readRecordValue(value);
  if (!record || !hasOnlyKeys(record, ['type', 'scope', 'actionRef', 'matcher'])) return false;
  const actionRef = readRecordValue(record.actionRef);
  return record.type === 'graph.authorize_tool_action'
    && record.scope === 'thread'
    && Boolean(actionRef)
    && hasOnlyKeys(actionRef as Record<string, unknown>, ['type'])
    && actionRef?.type === 'pending_action'
    && isToolAuthorizationMatcherTemplateValue(record.matcher);
}

function isReviewOptionValue(value: unknown): value is ReviewOption {
  const record = readRecordValue(value);
  if (
    !record
    || !hasOnlyKeys(record, ['id', 'label', 'description', 'variant', 'input', 'decision', 'effects'])
  ) {
    return false;
  }
  const effects = record.effects;
  return Boolean(readNonEmptyString(record.id))
    && typeof record.label === 'string'
    && (record.description === undefined || typeof record.description === 'string')
    && (
      record.variant === undefined
      || record.variant === 'primary'
      || record.variant === 'normal'
      || record.variant === 'danger'
    )
    && (record.input === undefined || isReviewOptionInputValue(record.input))
    && isReviewOptionDecisionValue(record.decision)
    && (effects === undefined || (Array.isArray(effects) && effects.every(isReviewEffectValue)));
}

export function isReviewSpecValue(value: unknown): value is ReviewSpec {
  const record = readRecordValue(value);
  if (!record || !hasOnlyKeys(record, ['id', 'schemaVersion', 'view', 'options'])) {
    return false;
  }
  return Boolean(readNonEmptyString(record.id))
    && typeof record.schemaVersion === 'number'
    && Number.isFinite(record.schemaVersion)
    && isReviewViewValue(record.view)
    && Array.isArray(record.options)
    && record.options.length > 0
    && record.options.every(isReviewOptionValue);
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

export type ReviewResponse = {
  reviewId: string;
  selectedOptionId: string;
  input?: Record<string, unknown>;
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
