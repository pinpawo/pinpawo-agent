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

export type HumanReviewPendingInterruptProjection = {
  interruptId: string;
  payload: HumanReviewInterruptProjection;
};

export type PendingInterruptProjection =
  | HumanReviewPendingInterruptProjection
  | {
      payload: {
        kind: 'pause_task';
      };
    };

export function readHumanReviewPendingInterrupt(
  value: PendingInterruptProjection | null,
): HumanReviewPendingInterruptProjection | null {
  return value?.payload.kind === 'human_review' && 'interruptId' in value
    ? value
    : null;
}
