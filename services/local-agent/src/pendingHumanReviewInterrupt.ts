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

/** Internal projection retaining authoritative pet-agent specs for response resolution. */
export type PendingHumanReviewInterruptRoute = {
  interruptId: string;
  reviews: ReviewSpec[];
};

export function matchesPendingHumanReviewInterrupt(
  route: PendingHumanReviewInterruptRoute,
  interruptId: string,
) {
  return interruptId === route.interruptId;
}

export function readHumanReviewResponses(msg: HumanReviewResponseMessage): ReviewResponse[] {
  return msg.responses.map(toInternalReviewResponse);
}

export function validateHumanReviewResponses(
  route: PendingHumanReviewInterruptRoute,
  msg: HumanReviewResponseMessage,
): ReviewResponse[] {
  const decisions = readHumanReviewResponses(msg);
  if (!decisions.length) {
    throw new ReviewResponseResolutionError(
      'invalid_response',
      'Human review response must include at least one interaction response.',
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
        `Human review decision "${resolution.reviewId}" stops the interrupt and must be final.`,
      );
    }
    if (
      resolution.decision.type === 'approve'
      && isFinalDecision
      && decisions.length < route.reviews.length
    ) {
      throw new ReviewResponseResolutionError(
        'invalid_response',
        `Human review interrupt is missing decisions after "${resolution.reviewId}".`,
      );
    }
  }
  return decisions;
}

export function buildHumanReviewResume(
  route: PendingHumanReviewInterruptRoute,
  decisions: ReviewResponse[],
) {
  return { [route.interruptId]: { decisions } };
}

export function buildHumanReviewCancelResume(
  route: PendingHumanReviewInterruptRoute,
) {
  const control = {
    action: 'interrupt_run',
  } as const;
  return { [route.interruptId]: control };
}

export type HumanReviewResume =
  | ReturnType<typeof buildHumanReviewResume>
  | ReturnType<typeof buildHumanReviewCancelResume>;

export type HumanReviewResolutionSource =
  | {
      type: 'human_review_response';
      interactionId: string;
      selectedOptionId: string;
      decisionCount: number;
      interruptRun?: true;
    }
  | {
      type: 'review.cancel';
      interactionId: string;
      decisionCount: 0;
    };

type HumanReviewResolutionMessage = HumanReviewResponseMessage | ReviewCancelMessage;

type ResolvableHumanReviewRoute = PendingHumanReviewInterruptRoute & { requestId: string };

type HumanReviewRunInterruptOptions<TRoute extends ResolvableHumanReviewRoute> = {
  recover: () => Promise<TRoute | null>;
  cancelPending: (route: TRoute) => Promise<void>;
};

/**
 * Normalizes a run-level stop intent against checkpoint-owned interrupt state. This
 * keeps clients transport-agnostic: a stale `run.interrupt` and an explicit
 * `review.cancel` follow the same canonical cancellation path once the server
 * knows that the run is waiting for review.
 */
export async function routeRunInterruptThroughHumanReview<
  TRoute extends ResolvableHumanReviewRoute,
>(options: HumanReviewRunInterruptOptions<TRoute>): Promise<boolean> {
  const route = await options.recover();
  if (!route) return false;
  await options.cancelPending(route);
  return true;
}

type HumanReviewResolutionOptions<TRoute extends ResolvableHumanReviewRoute> = {
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
  ) => Promise<unknown>;
};

/**
 * Executes the transport-independent human-review projection of a pending
 * interrupt. The function retains no lifecycle state: every attempt reloads
 * the authoritative checkpoint, validates the response, and builds a resume.
 * Session scoping, event delivery, and the resumed run stay at the handler
 * boundary.
 */
export async function resolvePendingHumanReviewInterrupt<
  TRoute extends ResolvableHumanReviewRoute,
>(options: HumanReviewResolutionOptions<TRoute>) {
  const { message } = options;
  const route = await options.recover();
  if (!route) {
    options.emitClosed();
    return;
  }

  if (!matchesPendingHumanReviewInterrupt(route, message.interruptId)) {
    options.emitEvent({
      type: 'error',
      requestId: message.requestId,
      message: '这个 interrupt 已经过期，请等待当前确认面板刷新后再操作。',
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
      decisions = validateHumanReviewResponses(route, message);
    } catch (err) {
      const interactionId = message.responses.at(-1)?.interactionId ?? 'missing';
      console.warn(
        `[human-review] response rejected: interactionId=${interactionId} `
        + `does not match pending interrupt=${route.interruptId} reviews=${route.reviews.map((review) => review.id).join(',')} `
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
    const finalDecision = decisions.at(-1)!;
    source = {
      type: 'human_review_response',
      interactionId: finalDecision.reviewId,
      selectedOptionId: finalDecision.selectedOptionId,
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
      interactionId: firstReview.id,
      decisionCount: 0,
    };
  }

  if (!options.isConnected()) {
    return;
  }

  await options.run(route, resume, source);
}
