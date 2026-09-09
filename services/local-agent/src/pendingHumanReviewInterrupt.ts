import type { HumanReviewResponse } from '@pinpawo/agent-contracts';
import {
  resolveHumanReviewResponse as resolveHumanReviewDecision,
  ReviewResponseResolutionError,
  toInternalReviewResponse,
  type ReviewResponse,
  type ReviewSpec,
} from '@pinpawo/pet-agent';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';
import type { InterruptResumeMessage } from './wire/localAgentProtocol';

/**
 * The review kind's resume values. `decisions` answers the reviews; `cancel`
 * withdraws the proposed action and stops the run. Both arrive through
 * interrupt.resume and are validated here against the authoritative
 * checkpoint before any of them reaches LangGraph.
 */
export type ReviewResumeValue =
  | { decisions: HumanReviewResponse[] }
  | { action: 'cancel' };

export function readReviewResumeValue(value: unknown): ReviewResumeValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.action === 'cancel') {
    return Object.keys(record).length === 1 ? { action: 'cancel' } : null;
  }
  if (!Array.isArray(record.decisions) || Object.keys(record).length !== 1) {
    return null;
  }
  return { decisions: record.decisions as HumanReviewResponse[] };
}

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

export function readHumanReviewResponses(
  responses: HumanReviewResponse[],
): ReviewResponse[] {
  return responses.map(toInternalReviewResponse);
}

export function validateHumanReviewResponses(
  route: PendingHumanReviewInterruptRoute,
  responses: HumanReviewResponse[],
): ReviewResponse[] {
  const decisions = readHumanReviewResponses(responses);
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

/**
 * The review kind's own resume value. The interrupt id is not folded in here:
 * it travels on the route, and the id-keyed LangGraph shape is built once, at
 * the graph service's adapter boundary.
 */
export function buildHumanReviewResumeValue(decisions: ReviewResponse[]) {
  return { decisions };
}

export function buildHumanReviewCancelResumeValue() {
  return { action: 'interrupt_run' } as const;
}

export type HumanReviewResumeValue =
  | ReturnType<typeof buildHumanReviewResumeValue>
  | ReturnType<typeof buildHumanReviewCancelResumeValue>;

/** What the person decided, for logging. Not a message type. */
export type HumanReviewResolutionSource =
  | {
      type: 'review_decision';
      interactionId: string;
      selectedOptionId: string;
      decisionCount: number;
    }
  | {
      type: 'review_cancel';
      interactionId: string;
      decisionCount: 0;
    };

type HumanReviewResolutionMessage = InterruptResumeMessage;

type ResolvableHumanReviewRoute = PendingHumanReviewInterruptRoute & { requestId: string };

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
    resume: HumanReviewResumeValue,
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
      code: 'interrupt_stale',
    });
    return;
  }
  const requested = readReviewResumeValue(message.value);
  if (!requested) {
    options.emitEvent({
      type: 'error',
      requestId: message.requestId,
      message: '这个 review 应答格式无法识别，请重新在确认面板上操作。',
      code: 'interrupt_stale',
    });
    return;
  }
  let resume: HumanReviewResumeValue;
  let source: HumanReviewResolutionSource;
  if ('decisions' in requested) {
    let decisions: ReviewResponse[];
    try {
      decisions = validateHumanReviewResponses(route, requested.decisions);
    } catch (err) {
      const interactionId = requested.decisions.at(-1)?.interactionId ?? 'missing';
      console.warn(
        `[human-review] response rejected: interactionId=${interactionId} `
        + `does not match pending interrupt=${route.interruptId} reviews=${route.reviews.map((review) => review.id).join(',')} `
        + (err instanceof Error ? err.message : String(err)),
      );
      options.emitEvent({
        type: 'error',
        requestId: message.requestId,
        message: '这个 review 已经过期，请等待当前确认面板刷新后再应答。',
        code: 'interrupt_stale',
      });
      return;
    }
    if (options.acceptRoute && !(await options.acceptRoute(route, message))) {
      return;
    }
    resume = buildHumanReviewResumeValue(decisions);
    const finalDecision = decisions.at(-1)!;
    source = {
      type: 'review_decision',
      interactionId: finalDecision.reviewId,
      selectedOptionId: finalDecision.selectedOptionId,
      decisionCount: decisions.length,
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
    resume = buildHumanReviewCancelResumeValue();
    source = {
      type: 'review_cancel',
      interactionId: firstReview.id,
      decisionCount: 0,
    };
  }

  if (!options.isConnected()) {
    return;
  }

  await options.run(route, resume, source);
}
