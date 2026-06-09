import {
  type PendingReviewAction,
  type ReviewSpec,
} from '@pinpawo/pet-agent';

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

function readPendingReviewActionValue(value: unknown): PendingReviewAction | null {
  const record = readRecordValue(value);
  if (!record) return null;
  const toolName = readNonEmptyString(record.toolName);
  const args = readRecordValue(record.args) ?? {};
  if (!toolName) return null;
  const actionId = readNonEmptyString(record.actionId) ?? 'pending_action';
  const description = readNonEmptyString(record.description);
  return {
    actionId,
    toolName,
    args,
    ...(description ? { description } : {}),
  };
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

export function readPendingReviewActionFromInterruptPayload(
  interruptPayload: Record<string, unknown>,
): PendingReviewAction | null {
  const directAction = readPendingReviewActionValue(interruptPayload.pendingAction);
  if (directAction) {
    return directAction;
  }

  return null;
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

export function formatInterruptPrompt(interruptPayload: Record<string, unknown>) {
  const directReview = readReviewSpecValue(interruptPayload.review);
  if (directReview) {
    return [
      directReview.view.title,
      directReview.view.body,
    ].filter((line): line is string => Boolean(line && line.trim())).join('\n')
      || '当前流程需要你的确认，请直接回复继续或说明下一步。';
  }

  return '当前流程需要你的确认，请等待当前确认面板刷新后再应答。';
}

export function buildHumanReviewResume(decisions: Array<Record<string, unknown>>) {
  return { decisions };
}

function buildResumeFromUserText(message: string) {
  const text = message.trim();
  return buildHumanReviewResume([
    text
      ? { type: 'respond', message: text }
      : { type: 'reject' },
  ]);
}

function readFirstResumeDecisionType(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const decisions = Array.isArray(record.decisions) ? record.decisions : [];
  const first = decisions[0];
  if (!first || typeof first !== 'object') return null;
  const type = (first as Record<string, unknown>).type;
  return typeof type === 'string' ? type : null;
}

export function normalizeInterruptResume(
  interruptPayload: Record<string, unknown>,
  message: string,
  explicitResume: unknown,
) {
  if (isHumanReviewInterruptPayload(interruptPayload)) {
    // Structured decisions take precedence. Otherwise treat the free-text
    // message as a `respond` decision (or `reject` if empty).
    return explicitResume !== undefined
      ? explicitResume
      : buildResumeFromUserText(message);
  }

  const explicitDecision = readFirstResumeDecisionType(explicitResume);
  if (explicitDecision === 'approve') {
    return { action: 'continue' };
  }
  if (explicitDecision === 'reject') {
    return { action: 'reject' };
  }
  return message;
}
