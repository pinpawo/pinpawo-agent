import type { ReviewResponse } from '@pinpawo/pet-agent';
import type { ReviewAction } from '@pinpawo/agent-session';

export type ReviewDraft = {
  actionId: string;
  decisions: ReviewResponse[];
  resolutionSent?: true;
};

export function currentReview(
  action: ReviewAction,
  draft: ReviewDraft,
) {
  if (action.actionId !== draft.actionId) return undefined;
  return action.reviews[draft.decisions.length];
}
