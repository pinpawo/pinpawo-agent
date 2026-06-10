import {
  isHumanReviewInterruptPayload as isCanonicalHumanReviewInterruptPayload,
  type ReviewSpec,
} from '@pinpawo/pet-agent';

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

export function isHumanReviewInterruptPayload(interruptPayload: Record<string, unknown>) {
  return isCanonicalHumanReviewInterruptPayload(interruptPayload);
}

export function buildReviewSpecFromInterruptPayload(
  interruptPayload: Record<string, unknown>,
): ReviewSpec | undefined {
  if (isCanonicalHumanReviewInterruptPayload(interruptPayload)) {
    return interruptPayload.review;
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
