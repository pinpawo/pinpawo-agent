export const HUMAN_REVIEW_REJECTED_CONTROL_TYPE = 'pinpawo.human_review_rejected' as const;
export const HUMAN_REVIEW_REJECTED_STOP_MESSAGE = '已拒绝执行，本轮已停止。';

export type HumanReviewRejectedToolResult = {
  ok: false;
  cancelled: true;
  rejected: true;
  control: {
    type: typeof HUMAN_REVIEW_REJECTED_CONTROL_TYPE;
    version: 1;
  };
  toolName: string;
  toolkitName: string;
  reason: string;
  input: unknown;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return readRecord(parsed);
  } catch {
    return null;
  }
}

export function buildHumanReviewRejectedToolResult(params: {
  toolName: string;
  toolkitName: string;
  reason: string;
  input: unknown;
}) {
  return JSON.stringify({
    ok: false,
    cancelled: true,
    rejected: true,
    control: {
      type: HUMAN_REVIEW_REJECTED_CONTROL_TYPE,
      version: 1,
    },
    toolName: params.toolName,
    toolkitName: params.toolkitName,
    reason: params.reason,
    input: params.input,
  } satisfies HumanReviewRejectedToolResult);
}

export function readHumanReviewRejectedToolResult(value: unknown): HumanReviewRejectedToolResult | null {
  const record = typeof value === 'string'
    ? parseJsonRecord(value)
    : readRecord(value);
  if (!record) return null;
  const control = readRecord(record.control);
  if (
    record.ok !== false
    || record.cancelled !== true
    || record.rejected !== true
    || control?.type !== HUMAN_REVIEW_REJECTED_CONTROL_TYPE
    || control.version !== 1
    || typeof record.toolName !== 'string'
    || typeof record.toolkitName !== 'string'
    || typeof record.reason !== 'string'
  ) {
    return null;
  }
  return record as HumanReviewRejectedToolResult;
}

export function isHumanReviewRejectedToolResult(value: unknown): boolean {
  return readHumanReviewRejectedToolResult(value) !== null;
}
