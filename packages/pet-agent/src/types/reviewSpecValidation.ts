import type {
  ReviewEffect,
  ReviewOption,
  ReviewOptionDecision,
  ReviewOptionInput,
  ReviewSpec,
  ReviewView,
} from './reviewSpec';

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

function isReviewEffectValue(value: unknown): value is ReviewEffect {
  const record = readRecordValue(value);
  if (!record || !hasOnlyKeys(record, ['type', 'scope'])) return false;
  return record.type === 'graph.authorize_tool_action'
    && record.scope === 'thread';
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
