
export type HumanReviewDecisionType = 'approve' | 'edit' | 'reject' | 'respond';

export type HumanReviewActionRequest = {
  name: string;
  args: Record<string, unknown>;
  description?: string;
};

export type HumanReviewDecision =
  | { type: 'approve' }
  | { type: 'edit'; editedAction: HumanReviewActionRequest }
  | { type: 'reject'; message?: string }
  | { type: 'respond'; message: string };
