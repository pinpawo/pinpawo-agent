import {
  resolveHumanReviewResponse as resolveHumanReviewDecision,
  ReviewResponseResolutionError,
  toInternalReviewResponse,
  type ReviewResponse,
  type ReviewSpec,
} from '@pinpawo/pet-agent';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import type {
  HumanReviewResponseMessage,
  ReviewCancelMessage,
} from './localAgentProtocol';
import {
  ReviewResolutionClaims,
  type ReviewResolutionRoute,
} from './reviewResolutionClaims';

/** Internal route: it retains the authoritative pet-agent specs for response resolution. */
export type HumanReviewActionRoute = {
  actionId: string;
  reviews: ReviewSpec[];
  interruptId?: string;
};

export function matchesHumanReviewAction(
  route: HumanReviewActionRoute,
  actionId: string | undefined,
) {
  return !actionId || actionId === route.actionId;
}

export function readHumanReviewDecisions(msg: HumanReviewResponseMessage): ReviewResponse[] {
  return msg.decisions?.map((decision) => (
    'interactionId' in decision ? toInternalReviewResponse(decision) : decision
  )) ?? [{
    reviewId: msg.interactionId ?? msg.reviewId,
    selectedOptionId: msg.selectedOptionId,
    ...(msg.input ? { input: msg.input } : {}),
  }];
}

export function validateHumanReviewDecisions(
  route: HumanReviewActionRoute,
  msg: HumanReviewResponseMessage,
): ReviewResponse[] {
  const decisions = readHumanReviewDecisions(msg);
  const interactionId = msg.interactionId ?? msg.reviewId;
  const finalDecision = decisions.at(-1);
  if (
    !finalDecision
    || finalDecision.reviewId !== interactionId
    || finalDecision.selectedOptionId !== msg.selectedOptionId
  ) {
    throw new ReviewResponseResolutionError(
      'stale_review',
      'Human review response must identify its final review action decision.',
    );
  }
  if (decisions.length > route.reviews.length) {
    throw new ReviewResponseResolutionError(
      'invalid_response',
      `Human review response includes ${decisions.length} decisions for ${route.reviews.length} pending reviews.`,
    );
  }

  for (let index = 0; index < decisions.length; index += 1) {
    const review = route.reviews[index];
    const decision = decisions[index];
    if (!review) {
      throw new ReviewResponseResolutionError(
        'invalid_response',
        `Human review decision "${decisions[index]?.reviewId ?? ''}" has no matching pending review.`,
      );
    }
    if (!decision) {
      throw new ReviewResponseResolutionError(
        'invalid_response',
        `Human review decision is missing for route step ${index}.`,
      );
    }
    if (decision.reviewId !== review.id) {
      throw new ReviewResponseResolutionError(
        'stale_review',
        `Human review decision "${decision.reviewId}" does not match pending review "${review.id}".`,
      );
    }
    const resolution = resolveHumanReviewDecision({ reviewSpec: review }, decision);
    const isFinalDecision = index === decisions.length - 1;
    if (resolution.decision.type !== 'approve' && !isFinalDecision) {
      throw new ReviewResponseResolutionError(
        'invalid_response',
        `Human review decision "${resolution.reviewId}" stops the review action and must be final.`,
      );
    }
    if (
      resolution.decision.type === 'approve'
      && isFinalDecision
      && decisions.length < route.reviews.length
    ) {
      throw new ReviewResponseResolutionError(
        'invalid_response',
        `Human review action is missing decisions after "${resolution.reviewId}".`,
      );
    }
  }
  return decisions;
}

function readRejectOptionId(review: ReviewSpec): string {
  const rejectOption = review.options.find((option) => option.decision.type === 'reject');
  if (rejectOption) return rejectOption.id;
  // No explicit reject option: fall back to the first non-approve option so the
  // decision still stops the review action on the pet-agent side.
  const nonApproveOption = review.options.find((option) => option.decision.type !== 'approve');
  if (nonApproveOption) return nonApproveOption.id;
  throw new ReviewResponseResolutionError(
    'invalid_response',
    `Review "${review.id}" has no option that can reject the review action.`,
  );
}

// Fail-closed resume: reject every pending review in the action. Used when we
// cannot safely map decisions to a specific interrupt (missing interruptId).
function buildRejectAllDecisions(route: HumanReviewActionRoute): ReviewResponse[] {
  return route.reviews.map((review) => ({
    reviewId: review.id,
    selectedOptionId: readRejectOptionId(review),
  }));
}

export function buildHumanReviewResume(
  route: HumanReviewActionRoute,
  decisions: ReviewResponse[],
) {
  if (route.interruptId) {
    return { [route.interruptId]: { decisions } };
  }
  // LangGraph always stamps an id on a real interrupt, so a missing interruptId
  // means this is not a resumable pending review action. Resuming by value would
  // risk delivering the decisions to the wrong interrupt, so fail closed: record
  // the anomaly and reject the whole review action instead of guessing.
  console.warn(
    `[human-review] missing interruptId for review action=${route.reviews.map((review) => review.id).join(',')}; `
    + 'rejecting all pending reviews',
  );
  return { decisions: buildRejectAllDecisions(route) };
}

export function buildHumanReviewRejectResume(
  route: HumanReviewActionRoute,
  rejectOptionId: string,
) {
  const firstReview = route.reviews[0];
  if (!firstReview) {
    throw new ReviewResponseResolutionError(
      'invalid_response',
      `Review action "${route.actionId}" has no reviews to cancel.`,
    );
  }
  return buildHumanReviewResume(route, [{
    reviewId: firstReview.id,
    selectedOptionId: rejectOptionId,
  }]);
}

export function buildHumanReviewCancelResume(
  route: HumanReviewActionRoute,
) {
  const control = {
    action: 'interrupt_run',
  } as const;
  return route.interruptId
    ? { [route.interruptId]: control }
    : control;
}

export type HumanReviewResume =
  | ReturnType<typeof buildHumanReviewResume>
  | ReturnType<typeof buildHumanReviewCancelResume>;

export type HumanReviewResolutionOutcome =
  | 'completed'
  | 'waiting_human'
  | 'interrupted'
  // The run failed but the agent is still usable, so the review action stays
  // parked for the user to decide again.
  | 'failed'
  // The agent itself is unusable (model quota exhausted, auth rejected). The
  // review action can never be resolved by retrying, so it is terminated
  // instead of being offered back to the user.
  | 'fatal_failed';

export type HumanReviewResolutionSource =
  | {
      type: 'human_review_response';
      reviewId: string;
      selectedOptionId: string;
      decisionCount: number;
      interruptRun?: true;
    }
  | {
      type: 'review.cancel';
      reviewId: string;
      decisionCount: 0;
    };

type HumanReviewResolutionMessage = HumanReviewResponseMessage | ReviewCancelMessage;

type ResolvableHumanReviewRoute = HumanReviewActionRoute & ReviewResolutionRoute;

type HumanReviewRunInterruptOptions<TRoute extends ResolvableHumanReviewRoute> = {
  lifecycle: ReviewResolutionClaims<TRoute>;
  requestId: string;
  cancelPending: (route: TRoute) => Promise<void>;
};

export type HumanReviewRunInterruptOutcome =
  | 'cancelled_pending'
  | 'queued_for_resolution'
  | 'unhandled';

/**
 * Normalizes a run-level stop intent against server-owned review state. This
 * keeps clients transport-agnostic: a stale `run.interrupt` and an explicit
 * `review.cancel` follow the same canonical cancellation path once the server
 * knows that the run is waiting for review.
 */
export async function routeRunInterruptThroughHumanReview<
  TRoute extends ResolvableHumanReviewRoute,
>(options: HumanReviewRunInterruptOptions<TRoute>): Promise<HumanReviewRunInterruptOutcome> {
  const disposition = options.lifecycle.routeRunInterrupt(options.requestId);
  if (disposition.type === 'cancel_pending') {
    await options.cancelPending(disposition.route);
    return 'cancelled_pending';
  }
  if (disposition.type === 'queued') {
    return 'queued_for_resolution';
  }
  return 'unhandled';
}

type HumanReviewResolutionOptions<TRoute extends ResolvableHumanReviewRoute> = {
  lifecycle: ReviewResolutionClaims<TRoute>;
  message: HumanReviewResolutionMessage;
  recover: () => Promise<TRoute | null>;
  emitClosed: () => void;
  emitEvent: (event: AgentRuntimeEvent) => void;
  acceptRoute?: (
    route: TRoute,
    message: HumanReviewResolutionMessage,
  ) => boolean | Promise<boolean>;
  isConnected: () => boolean;
  run: (
    route: TRoute,
    resume: HumanReviewResume,
    source: HumanReviewResolutionSource,
  ) => Promise<HumanReviewResolutionOutcome>;
};

/**
 * Executes the transport-independent review resolution flow. Route recovery,
 * session/user scoping, event delivery, and the resumed run stay at the handler
 * boundary; lifecycle transitions and response validation stay here.
 */
export async function resolveHumanReviewAction<
  TRoute extends ResolvableHumanReviewRoute,
>(options: HumanReviewResolutionOptions<TRoute>) {
  const { lifecycle, message } = options;
  const resolution = await lifecycle.claim(
    {
      requestId: message.requestId,
      ...(message.actionId ? { actionId: message.actionId } : {}),
    },
    options.recover,
  );
  if (!resolution) {
    options.emitClosed();
    return;
  }

  const { actionId, route } = resolution;
  let outcome: HumanReviewResolutionOutcome = 'failed';
  try {
    if (!matchesHumanReviewAction(route, message.actionId)) {
      options.emitEvent({
        type: 'error',
        requestId: message.requestId,
        message: '这个 review action 已经过期，请等待当前确认面板刷新后再操作。',
        code: 'review_stale',
      });
      return;
    }
    let resume: HumanReviewResume;
    let source: HumanReviewResolutionSource;
    let interruptRun = false;
    if (message.type === 'human_review_response') {
      let decisions: ReviewResponse[];
      try {
        decisions = validateHumanReviewDecisions(route, message);
      } catch (err) {
        console.warn(
          `[human-review] response rejected: reviewId=${message.interactionId ?? message.reviewId} `
          + `does not match pending review action=${route.reviews.map((review) => review.id).join(',')} `
          + (err instanceof Error ? err.message : String(err)),
        );
        options.emitEvent({
          type: 'error',
          requestId: message.requestId,
          message: '这个 review 已经过期，请等待当前确认面板刷新后再应答。',
          code: 'review_stale',
        });
        return;
      }
      interruptRun = decisions.some((decision, index) => {
        const review = route.reviews[index];
        return review
          ? resolveHumanReviewDecision({ reviewSpec: review }, decision).decision.type === 'reject'
          : false;
      });
      if (options.acceptRoute && !(await options.acceptRoute(route, message))) {
        return;
      }
      resume = buildHumanReviewResume(route, decisions);
      source = {
        type: 'human_review_response',
        reviewId: message.interactionId ?? message.reviewId,
        selectedOptionId: message.selectedOptionId,
        decisionCount: decisions.length,
        ...(interruptRun ? { interruptRun: true } : {}),
      };
    } else {
      if (options.acceptRoute && !(await options.acceptRoute(route, message))) {
        return;
      }
      const firstReview = route.reviews[0];
      if (!firstReview) {
        options.emitClosed();
        return;
      }
      resume = buildHumanReviewCancelResume(route);
      source = {
        type: 'review.cancel',
        reviewId: firstReview.id,
        decisionCount: 0,
      };
    }

    if (!options.isConnected()) {
      return;
    }
    if (
      (message.type === 'review.cancel' || interruptRun)
      && !lifecycle.queueInterrupt(message.requestId)
    ) {
      throw new Error(
        `Review cancellation could not queue interruption for request "${message.requestId}".`,
      );
    }

    outcome = await options.run(route, resume, source);
  } finally {
    // Successful runs release the claimed route generation; a same-id review
    // registered by the resumed run is newer and survives. Interrupted runs
    // are consumed only after checkpoint confirmation, while fatal failures
    // keep a bounded local close marker so the unresolved checkpoint review is
    // not immediately re-offered.
    lifecycle.release(actionId, {
      outcome: outcome === 'completed' || outcome === 'waiting_human'
        ? 'resolved'
        : outcome,
    });
  }
}
