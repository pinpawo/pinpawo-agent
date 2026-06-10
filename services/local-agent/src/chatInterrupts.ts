import type { ReviewSpec } from '@pinpawo/pet-agent';

function readRecordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readReviewSpecValue(value: unknown): ReviewSpec | null {
  const record = readRecordValue(value);
  if (!record) return null;

  const id = readNonEmptyString(record.id);
  const schemaVersion = typeof record.schemaVersion === 'number' && Number.isFinite(record.schemaVersion)
    ? record.schemaVersion
    : null;
  const view = readRecordValue(record.view);
  const viewKind = view ? readNonEmptyString(view.kind) : null;
  const viewBody = view && typeof view.body === 'string' ? view.body : null;
  const options = Array.isArray(record.options) ? record.options : null;

  if (
    !id
    || schemaVersion == null
    || (viewKind !== 'plain' && viewKind !== 'markdown')
    || viewBody == null
    || !options
  ) {
    return null;
  }

  const validOptions = options.every((option) => {
    const optionRecord = readRecordValue(option);
    const decision = optionRecord ? readRecordValue(optionRecord.decision) : null;
    return Boolean(
      optionRecord
      && readNonEmptyString(optionRecord.id)
      && typeof optionRecord.label === 'string'
      && decision,
    );
  });

  return validOptions ? record as ReviewSpec : null;
}

export function readPendingInterrupt(snapshot: { tasks?: unknown }): Record<string, unknown> | null {
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    const interrupts = Array.isArray((task as { interrupts?: unknown }).interrupts)
      ? (task as { interrupts: unknown[] }).interrupts
      : [];
    const first = interrupts[0];
    if (first && typeof first === 'object' && 'value' in first && first.value && typeof first.value === 'object') {
      return first.value as Record<string, unknown>;
    }
  }
  return null;
}

function isReviewInterruptPayload(interruptPayload: Record<string, unknown>) {
  return interruptPayload.kind === 'review'
    && Boolean(readReviewSpecValue(interruptPayload.review));
}

export function isHumanReviewInterruptPayload(interruptPayload: Record<string, unknown>) {
  return isReviewInterruptPayload(interruptPayload);
}

export function buildReviewSpecFromInterruptPayload(
  interruptPayload: Record<string, unknown>,
): ReviewSpec | undefined {
  const directReview = readReviewSpecValue(interruptPayload.review);
  if (directReview) {
    return directReview;
  }
  return undefined;
}

export function normalizeInterruptResume(
  interruptPayload: Record<string, unknown>,
  message: string,
  explicitResume: unknown,
) {
  if (isHumanReviewInterruptPayload(interruptPayload)) {
    return explicitResume;
  }

  return explicitResume !== undefined ? explicitResume : message;
}
