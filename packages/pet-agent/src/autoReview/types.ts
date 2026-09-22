import type { StructuredOutputOptions } from '../utils/structuredOutput';
import type { ToolOperationMetadata, ToolkitReviewGuidance } from './policy';
import type { ReviewSpec } from '../types/reviewSpec';

/** Facts for one proposed action, not an authorization grant or Root snapshot. */
export type AutoReviewAction = {
  toolkitName: string;
  toolName: string;
  input: unknown;
  operation?: ToolOperationMetadata;
  autoReviewContext?: ToolkitReviewGuidance;
  review: ReviewSpec;
  /** Candidate policy metadata, not an existing grant or instruction to approve. */
  authorization?: {
    matcherType: 'exact' | 'url_origin';
    reuseAutoReview: boolean;
  };
};

export type AutoReviewInput = {
  reviews: AutoReviewAction[];
  /** Non-authoritative relevance hint; cannot establish permission. */
  task?: string | null;
};

export type AutoReviewStructuredOutputConfig = Omit<StructuredOutputOptions, 'name'>;

export type ReviewAssessment = { riskScore: number; reason: string };
export type AutoReviewResult =
  | { complete: false }
  | { complete: true; assessment: ReviewAssessment };

/** Dynamic evaluator; callers own approval thresholds, grants and execution. */
export type AutoReviewer = {
  assess(input: AutoReviewInput): Promise<AutoReviewResult>;
};
