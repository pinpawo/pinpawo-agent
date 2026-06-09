import type { ReviewOptionInput } from '@pinpawo/pet-agent';
import type { ApprovalOption, PendingApproval } from './types';

export function buildApprovalOptions(approval: PendingApproval): ApprovalOption[] {
  const review = approval.review;
  if (!review) {
    return [];
  }

  return review.options.map((option) => ({
    label: option.label,
    message: option.label,
    ...(option.description ? { description: option.description } : {}),
    ...(option.variant ? { variant: option.variant } : {}),
    reviewId: review.id,
    selectedOptionId: option.id,
    ...(option.input ? { input: option.input as ReviewOptionInput } : {}),
  }));
}

export function findTextInputOption(options: ApprovalOption[]) {
  return options.find((option) => option.input?.kind === 'text') ?? null;
}
