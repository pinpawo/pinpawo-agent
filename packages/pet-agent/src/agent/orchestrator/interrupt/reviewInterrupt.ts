import {
  RemoveMessage,
  ToolMessage,
  type BaseMessage,
  type ToolCall,
} from '@langchain/core/messages';
import { interrupt } from '@langchain/langgraph';
import {
  applyReviewEffects,
  ReviewEffectApplicationError,
  type ToolAuthorizationRecord,
} from '../review/reviewAuthorizations';
import type { ToolAuthorizationMatcher } from '../review/authorizationMatchers';
import {
  isHumanReviewCancelResume,
  resolveHumanReviewBatchResume,
  ReviewResponseResolutionError,
} from '../review/reviewResponseResolver';
import {
  appendReviewViewMessage,
  type HumanReviewBatchInterruptPayload,
  type HumanReviewInterruptPayload,
  type ReviewResponseResolution,
} from '../review/reviewSpec';
import type { AgentInterrupt } from './agentInterrupt';

export type ReviewInterruptReview = {
  toolCall: ToolCall;
  toolkitName: string;
  toolName: string;
  input: unknown;
  reviewPayload: HumanReviewInterruptPayload;
  authorizationMatcher: ToolAuthorizationMatcher | null;
};

export type ReviewInterruptResolution =
  | {
      type: 'approve';
      authorizations: ToolAuthorizationRecord[];
      approvedReviewIds: string[];
      next: 'tools';
    }
  | {
      type: 'respond';
      messages: BaseMessage[];
      next: 'model';
    }
  | {
      type: 'reject';
      messages: BaseMessage[];
      next: 'pause_task';
    }
  | {
      type: 'cancel';
      messages: BaseMessage[];
      next: 'pause_task';
    };

export type ReviewInterruptOptions = {
  reviews: ReviewInterruptReview[];
  toolCalls: ToolCall[];
  aiMessageId: string | null;
};

function readToolCallId(toolCall: ToolCall) {
  const id = toolCall.id;
  return typeof id === 'string' && id.trim() ? id.trim() : 'pending_action';
}

function buildReviewToolResult(params: {
  review: ReviewInterruptReview;
  reason: string;
  source: 'human_reject' | 'human_respond';
}) {
  return JSON.stringify({
    ok: false,
    cancelled: true,
    source: params.source,
    toolName: params.review.toolName,
    toolkitName: params.review.toolkitName,
    reason: params.reason,
    input: params.review.input,
    retryable: false,
    guidance: params.source === 'human_reject'
      ? 'Follow the user rejection and any updated direction. Do not retry this exact tool call unless the user explicitly asks for it.'
      : 'Treat the user response as new task guidance, replan, and continue without retrying this exact tool call.',
  });
}

function buildSkippedToolResult(toolCall: ToolCall) {
  return JSON.stringify({
    ok: false,
    cancelled: true,
    skipped: true,
    toolName: toolCall.name,
    reason: 'Skipped because another tool call in this review action was cancelled before any tools executed.',
    input: toolCall.args,
    retryable: false,
    guidance: 'Do not retry this same review action. Replan from the cancellation feedback.',
  });
}

function buildToolMessage(toolCall: ToolCall, content: string) {
  return new ToolMessage({
    content,
    name: toolCall.name,
    tool_call_id: readToolCallId(toolCall),
  });
}

function appendInvalidDecisionMessage(
  payload: HumanReviewInterruptPayload,
): HumanReviewInterruptPayload {
  const message = '无法识别你的决定。请批准、拒绝，或直接输入新的处理方向。';
  return {
    ...payload,
    error: 'invalid_decision',
    review: {
      ...payload.review,
      view: appendReviewViewMessage(payload.review.view, message),
    },
  };
}

function buildInvalidDecisionRequest(
  payload: HumanReviewBatchInterruptPayload,
): HumanReviewBatchInterruptPayload {
  return {
    ...payload,
    error: 'invalid_decision',
    reviews: payload.reviews.map(appendInvalidDecisionMessage),
  };
}

async function buildAuthorizations(
  reviews: ReviewInterruptReview[],
  resolutions: ReviewResponseResolution[],
) {
  if (resolutions.length !== reviews.length) {
    throw new ReviewResponseResolutionError(
      'invalid_response',
      `Review action approved ${resolutions.length} of ${reviews.length} pending reviews.`,
    );
  }
  const authorizations: ToolAuthorizationRecord[] = [];
  for (let index = 0; index < resolutions.length; index += 1) {
    const review = reviews[index]!;
    authorizations.push(...await applyReviewEffects({
      toolName: review.toolName,
      matcher: review.authorizationMatcher,
      effects: resolutions[index]!.effects,
    }));
  }
  return authorizations;
}

function buildDecisionMessages(params: {
  toolCalls: ToolCall[];
  review: ReviewInterruptReview;
  decision: Extract<ReviewResponseResolution['decision'], { type: 'reject' | 'respond' }>;
}) {
  const reason = params.decision.type === 'respond'
    ? params.decision.message
    : params.decision.message ?? 'tool call rejected by user';
  const source = params.decision.type === 'respond'
    ? 'human_respond' as const
    : 'human_reject' as const;
  return params.toolCalls.map((toolCall) => buildToolMessage(
    toolCall,
    readToolCallId(toolCall) === readToolCallId(params.review.toolCall)
      ? buildReviewToolResult({ review: params.review, reason, source })
      : buildSkippedToolResult(toolCall),
  ));
}

export class ReviewInterrupt implements AgentInterrupt<
  HumanReviewBatchInterruptPayload,
  ReviewInterruptResolution
> {
  readonly kind = 'review_batch';
  readonly #options: ReviewInterruptOptions;

  constructor(options: ReviewInterruptOptions) {
    if (options.reviews.length === 0) {
      throw new Error('ReviewInterrupt requires at least one review.');
    }
    this.#options = options;
  }

  interaction(): HumanReviewBatchInterruptPayload {
    return {
      kind: this.kind,
      reviews: this.#options.reviews.map((review) => review.reviewPayload),
    };
  }

  async resume(value: unknown): Promise<ReviewInterruptResolution> {
    if (isHumanReviewCancelResume(value)) {
      const aiMessageId = this.#options.aiMessageId;
      if (!aiMessageId) {
        throw new Error('Cannot cancel a reviewed AI action without a message id.');
      }
      return {
        type: 'cancel',
        messages: [new RemoveMessage({ id: aiMessageId }) as BaseMessage],
        next: 'pause_task',
      };
    }

    const resolutions = resolveHumanReviewBatchResume(
      this.#options.reviews.map((review) => ({
        reviewSpec: review.reviewPayload.review,
        ...(review.reviewPayload.pendingAction
          ? { pendingAction: review.reviewPayload.pendingAction }
          : {}),
      })),
      value,
    );
    const firstNonApproval = resolutions.find((resolution) =>
      resolution.decision.type !== 'approve');
    if (firstNonApproval) {
      const review = this.#options.reviews[resolutions.indexOf(firstNonApproval)]!;
      const decision = firstNonApproval.decision;
      if (decision.type === 'respond') {
        return {
          type: 'respond',
          messages: buildDecisionMessages({
            toolCalls: this.#options.toolCalls,
            review,
            decision,
          }),
          next: 'model',
        };
      }
      if (decision.type !== 'reject') {
        throw new Error('ReviewInterrupt selected an approval as a non-approval.');
      }
      return {
        type: 'reject',
        messages: buildDecisionMessages({
          toolCalls: this.#options.toolCalls,
          review,
          decision,
        }),
        next: 'pause_task',
      };
    }

    return {
      type: 'approve',
      authorizations: await buildAuthorizations(this.#options.reviews, resolutions),
      approvedReviewIds: this.#options.reviews.map((review) => review.reviewPayload.review.id),
      next: 'tools',
    };
  }

  async run(): Promise<ReviewInterruptResolution> {
    let payload = this.interaction();
    while (true) {
      const value = interrupt(payload);
      try {
        return await this.resume(value);
      } catch (error) {
        if (
          !(error instanceof ReviewResponseResolutionError)
          && !(error instanceof ReviewEffectApplicationError)
        ) {
          throw error;
        }
        payload = buildInvalidDecisionRequest(payload);
      }
    }
  }
}
