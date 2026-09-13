import type { ReviewSpec } from '../types/reviewSpec';
import type { ToolAuthorizationMatcher } from './authorizationMatchers';

export type ToolkitReviewCapabilities = {
  humanReview: boolean;
  sessionAuthorization: boolean;
};

export type ToolOperationSummary = {
  target?: string;
  summary?: string;
  details?: Record<string, unknown>;
};

export type ToolOperationMetadata = {
  title?: string;
  titleKey?: string;
  summarizeInput?: (input: unknown) => ToolOperationSummary | null;
  summarizeOutput?: (output: unknown) => ToolOperationSummary | null;
  summarizeError?: (error: unknown) => ToolOperationSummary | null;
};

export type ToolReviewContext = {
  toolkitName: string;
  toolName: string;
  input: unknown;
  operation?: ToolOperationMetadata;
  reviewCapabilities?: ToolkitReviewCapabilities;
  authorizationMatcher?: ToolAuthorizationMatcher | null;
};

export type ToolAuthorizationContext = {
  toolkitName: string;
  toolName: string;
  input: unknown;
  operation?: ToolOperationMetadata;
};

export type ToolAutoAuthorizationContext = ToolAuthorizationContext & {
  /** Effective runtime workdir used to evaluate mutation scope. */
  workdir: string | null;
};

/**
 * One tool chooses exactly one authorization strategy:
 * deterministic authorization of each current call, or reusable session
 * authorization through a matcher. The strategies are intentionally
 * mutually exclusive so a session hit can never bypass a current-call check.
 */
export type ToolAuthorizationPolicy =
  | {
      /**
       * Deterministically authorize the current call from trusted runtime facts.
       * `true` grants this call; `false` defers to the remaining review flow and
       * does not reject the call.
       */
      authorize: (
        ctx: ToolAutoAuthorizationContext,
      ) => boolean | Promise<boolean>;
      buildMatcher?: never;
      reuseAutoReview?: never;
    }
  | {
      authorize?: never;
      /** Build the identity used to reuse a prior authorization in this session. */
      buildMatcher: (
        ctx: ToolAuthorizationContext,
      ) => ToolAuthorizationMatcher | null | Promise<ToolAuthorizationMatcher | null>;
      /** Opt in only when matching subjects preserve the risk-relevant effects.
       * False/omitted permits human grants only. Runtime also requires exact.
       */
      reuseAutoReview?: boolean;
    };

export type ToolReviewBlock = {
  type: 'block';
  reason: string;
};

export type ToolReviewResult = ReviewSpec | ToolReviewBlock | null;

export type ToolReviewPolicy = {
  /**
   * Produce the review requirement for one tool call.
   *
   * The policy must be idempotent and side-effect free. Review middleware can
   * invoke it again when a suspended review resumes.
   */
  request: (
    ctx: ToolReviewContext,
  ) => ToolReviewResult | Promise<ToolReviewResult>;
  authorization?: ToolAuthorizationPolicy;
};

export type ToolkitReviewGuidance = {
  /**
   * Toolkit-owned guidance for a global review classifier.
   *
   * Deterministic per-tool requirements belong in `ToolDefinition.review`.
   */
  allow: string;
  ask: string;
};

export const TOOLKIT_REVIEW_GUIDANCE_FIELD_MAX_CHARS = 2_000;
