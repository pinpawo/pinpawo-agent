import { z } from 'zod';

const reviewResponseSchema = z.object({
  reviewId: z.string().trim().min(1),
  selectedOptionId: z.string().trim().min(1),
  input: z.record(z.unknown()).optional(),
}).strict();

export const humanReviewBatchResponseSchema = z.object({
  decisions: z.array(reviewResponseSchema).min(1),
}).strict();

export const humanReviewCancelResumeSchema = z.object({
  action: z.enum(['cancel', 'interrupt_run']),
}).strict();

/** The transport shape only; review identities and effects remain runtime policy. */
export const humanReviewResumeSchema = z.union([
  humanReviewBatchResponseSchema,
  humanReviewCancelResumeSchema,
]);

/** Preflight before the Host sends a checkpointed, interrupt-addressed Command. */
export function isValidHumanReviewResume(value: unknown): boolean {
  return humanReviewResumeSchema.safeParse(value).success;
}
