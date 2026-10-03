import { parseHumanReviewRequest } from '@pinpawo/agent-contracts';
import type {
  HumanReviewOption,
  HumanReviewOptionInput,
  HumanReviewRequest,
  HumanReviewResponse,
  HumanReviewView,
} from '@pinpawo/agent-contracts';

export type {
  HumanReviewRequest,
  HumanReviewResponse,
} from '@pinpawo/agent-contracts';

export type ReviewSpec = HumanReviewRequest;
export type ReviewOption = HumanReviewOption;
export type ReviewOptionInput = HumanReviewOptionInput;
export type ReviewResponse = HumanReviewResponse;
export type ReviewView = HumanReviewView;

export type HumanReviewInterruptProjection = {
  kind: 'human_review';
  interactions: HumanReviewRequest[];
};

export type PauseTaskInterruptProjection = {
  kind: 'pause_task';
};

export type InterruptPayloadProjection =
  | HumanReviewInterruptProjection
  | PauseTaskInterruptProjection;

/**
 * Every pending interrupt carries its id, whatever the kind. Interfaces
 * render by `payload.kind` and resume by `interruptId`; nothing else needs to
 * tell the kinds apart.
 */
export type PendingInterruptProjection = {
  interruptId: string;
  payload: InterruptPayloadProjection;
};

export type HumanReviewPendingInterruptProjection = PendingInterruptProjection & {
  payload: HumanReviewInterruptProjection;
};

export function readHumanReviewPendingInterrupt(
  value: PendingInterruptProjection | null,
): HumanReviewPendingInterruptProjection | null {
  return value?.payload.kind === 'human_review'
    ? value as HumanReviewPendingInterruptProjection
    : null;
}

/** Validate the existing public projection without accepting runtime decisions/effects. */
export function parsePendingInterruptProjection(value: unknown): PendingInterruptProjection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pending = value as Record<string, unknown>;
  if (Object.keys(pending).some(key => !['interruptId', 'payload'].includes(key))
    || typeof pending.interruptId !== 'string' || !pending.interruptId.trim()) return null;
  if (!pending.payload || typeof pending.payload !== 'object' || Array.isArray(pending.payload)) return null;
  const payload = pending.payload as Record<string, unknown>;
  if (payload.kind === 'pause_task' && Object.keys(payload).length === 1) {
    return { interruptId: pending.interruptId, payload: { kind: 'pause_task' } };
  }
  if (payload.kind !== 'human_review' || Object.keys(payload).some(key => !['kind', 'interactions'].includes(key))
    || !Array.isArray(payload.interactions) || !payload.interactions.length) return null;
  const interactions = payload.interactions.map(parseHumanReviewRequest);
  if (interactions.some(item => item === null)) return null;
  return { interruptId: pending.interruptId, payload: { kind: 'human_review', interactions: interactions as HumanReviewRequest[] } };
}
