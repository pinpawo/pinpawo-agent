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
