import {
  applySessionSnapshot,
  parseAgentServerMessage,
  prepareReviewDecision,
  readHumanReviewPendingInterrupt,
  reduceSession,
  type AgentServerMessage,
  type AgentSession,
  type AgentSessionSnapshot,
  type HumanReviewPendingInterruptProjection,
  type ReviewResponse,
} from '@pinpawo/agent-session';
import { EventStreamError, observeEventStream } from './studioEvents';

/** Exactly which session a reader is looking at, and where it was opened from. */
export type PetSessionTarget = { petId: string; sessionId: string; executionId?: string };

export function petSessionQuery(target: PetSessionTarget): string {
  return `petId=${encodeURIComponent(target.petId)}&sessionId=${encodeURIComponent(target.sessionId)}`;
}

function emptySession(sessionId: string): AgentSession {
  return { sessionId, kind: 'chat', timeline: [], activeRun: null, pendingInterrupt: null };
}

/**
 * Fold one message of the observed session into the reader's projection, with
 * the same reducer the TUI uses. A snapshot replaces everything, so every
 * (re)connection starts again from the Host's authoritative state.
 */
export function applyPetSessionMessage(
  session: AgentSession | null,
  message: AgentServerMessage,
  target: PetSessionTarget,
  observedAt = Date.now(),
): AgentSession | null {
  if (message.type === 'session.snapshot.result') {
    return applySessionSnapshot(emptySession(target.sessionId), message.snapshot, { observedAt });
  }
  if (message.type !== 'event' || !session) return session;
  return reduceSession(session, { type: 'runtime.event', event: message.event }, { observedAt });
}

export function readPetSessionSnapshot(session: AgentSessionSnapshot, target: PetSessionTarget): AgentSession {
  return applySessionSnapshot(emptySession(target.sessionId), session, { observedAt: Date.now() });
}

/** Follow one session; the first message after every connection is its snapshot. */
export function observePetSession(options: {
  url: string;
  token: string;
  target: PetSessionTarget;
  signal: AbortSignal;
  onConnected: () => void;
  onDisconnected: (error: Error, retrying: boolean) => void;
  onMessage: (message: AgentServerMessage) => void;
  fetch?: typeof fetch;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  return observeEventStream({
    url: `${options.url}/pet-sessions/events?${petSessionQuery(options.target)}`,
    headers: { Authorization: `Bearer ${options.token}` },
    signal: options.signal,
    onConnected: options.onConnected,
    onDisconnected: options.onDisconnected,
    onEvent: options.onMessage,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.wait ? { wait: options.wait } : {}),
  }, (data) => {
    const message = parseAgentServerMessage(data);
    if (!message) throw new EventStreamError('Invalid Agent Session message.');
    return message;
  });
}

/** The review a reader may answer: only the one in the latest authoritative state. */
export function currentPetSessionReview(session: AgentSession | null): HumanReviewPendingInterruptProjection | null {
  return readHumanReviewPendingInterrupt(session?.pendingInterrupt ?? null);
}

/**
 * Answers collected for the current review. Options decide whether the batch
 * waits for the next interaction (`defer`) or goes now (`immediate`, or the
 * last interaction); the Host validates everything again before it resumes.
 */
export type PetSessionReviewDraft = { interruptId: string; responses: ReviewResponse[] };

export type PetSessionReviewStep =
  | { kind: 'collect'; draft: PetSessionReviewDraft }
  | { kind: 'send'; body: PetSessionReviewBody }
  | { kind: 'input-required' }
  | { kind: 'stale' };

export type PetSessionReviewBody = {
  petId: string;
  sessionId: string;
  requestId: string;
  interruptId: string;
  value: { decisions: ReviewResponse[] };
};

export function choosePetSessionReviewOption(params: {
  target: PetSessionTarget;
  review: HumanReviewPendingInterruptProjection;
  draft: PetSessionReviewDraft | null;
  optionId: string;
  inputText?: string;
  requestId: string;
}): PetSessionReviewStep {
  const responses = params.draft?.interruptId === params.review.interruptId ? params.draft.responses : [];
  const prepared = prepareReviewDecision({
    pendingInterrupt: params.review,
    responses,
    optionId: params.optionId,
    ...(params.inputText !== undefined ? { inputText: params.inputText } : {}),
  });
  if (!prepared.ok) return { kind: prepared.reason === 'input-required' ? 'input-required' : 'stale' };
  if (!prepared.shouldSend) {
    return { kind: 'collect', draft: { interruptId: params.review.interruptId, responses: prepared.responses } };
  }
  return {
    kind: 'send',
    body: {
      petId: params.target.petId,
      sessionId: params.target.sessionId,
      requestId: params.requestId,
      interruptId: params.review.interruptId,
      value: { decisions: prepared.responses },
    },
  };
}

/**
 * What the session's stream said about one submitted answer: the resumed run
 * started, or the Host refused it (closed, stale, or another session's review).
 */
export function readPetSessionReviewOutcome(
  message: AgentServerMessage,
  requestId: string,
): { kind: 'accepted' } | { kind: 'refused'; message: string } | null {
  if (message.type !== 'event' || message.event.requestId !== requestId) return null;
  if (message.event.type === 'run.started') return { kind: 'accepted' };
  if (message.event.type === 'error') return { kind: 'refused', message: message.event.message };
  return null;
}
