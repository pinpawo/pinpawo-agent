import type { PetInvocationScope } from './petInvocationContext';
import type { Deliverable } from '@pinpawo/agent-contracts';
import type {
  PendingInterruptProjection,
  AgentClientMessage,
  AgentRuntimeEvent,
  AgentServerMessage,
  AgentSessionSnapshot,
  AgentMessageCompletedEvent,
  HumanReviewResponse,
} from '@pinpawo/agent-session';

/**
 * The Host's port contracts.
 *
 * A Host exposes two asymmetric surfaces over one Pet: dispatch, which accepts
 * one-way input and is observed, and interaction, which is the single
 * interactive connection (domains §一.3b). They are declared together here
 * because they describe the same Host from two sides, and because the runtime
 * that implements them should be readable without scrolling past its own
 * vocabulary.
 */

export type PetDispatchState = 'open' | 'busy' | 'waiting' | 'blocked';
export type PetDispatchSettledState = Exclude<PetDispatchState, 'busy'>;

/** One coherent snapshot of the resident admission queue and its current state. */
export type PetDispatchQueueSnapshot = {
  state: PetDispatchState;
  activeOperation: 'conversation' | 'dispatch' | null;
  queuedConversations: number;
  queuedDispatches: number;
  /** Runtime-owned entries in their current queue order; never includes input text. */
  entries?: PetDispatchQueueEntry[];
  activeDispatch?: PetDispatchQueueEntry;
};

export type PetDispatchQueueEntry = {
  /** Source identity for read-only scheduling observation; not execution context. */
  origin?: PetInvocationScope;
  dispatchId: string;
  enqueuedAt: string;
  sessionId?: string;
  scope?: PetInvocationScope;
};

/** A continuation is only eligible for this exact, explicitly addressed domain session. */
export type PetDispatchTarget = { sessionId: string; scope: PetInvocationScope };

/** Scoped execution facts; not an admission check or a durable history. */
export type PetDispatchExecution = {
  active?: PetDispatchQueueEntry & Pick<PetDispatchLifecycleEvent, 'resumesDispatchId'>;
  queued: PetDispatchQueueEntry[];
  recent: Array<Pick<PetDispatchLifecycleEvent, 'dispatchId' | 'origin' | 'resumesDispatchId'> & {
    state: Exclude<PetDispatchLifecycleState, 'queued' | 'running' | 'message'>;
  }>;
};

export type PetDispatchRequest = {
  /** Source identity for queue observation only; not execution or review context. */
  origin?: PetInvocationScope;
  request: string;
  /** In-process cancellation until the resident accepts the request. */
  signal?: AbortSignal;
  /** Explicit in-process input references; never inferred from request text. */
  attachments?: readonly Deliverable[];
  /** One ID per admitted dispatch. Never reuse it for another submission. */
  dispatchId?: string;
  /** Explicit durable session; create only when registering a reserved identity. */
  session?: { id: string; create?: boolean };
  /** Explicit Host-admitted domain scope, independent of the Agent Session. */
  scope?: PetInvocationScope;
  /** Trusted Host caller only: interrupt the target, or admit only if it can start without queueing. */
  delivery?: 'interrupt' | 'idle-only';
};

export type PetDispatchLifecycleState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'interrupted'
  | 'superseded'
  | 'failed'
  /** Non-terminal: the running dispatch's conversation completed its public reply. */
  | 'message';

/**
 * The dispatch's public reply, as Agent Session carries it. Tool-call messages
 * and their settlements are the run's process and stay in Agent Session.
 */
export type PetDispatchMessage = Omit<AgentMessageCompletedEvent, 'requestId'>;

/** Narrow a runtime event to what dispatch observers see of the conversation. */
export function readPetDispatchMessage(event: AgentRuntimeEvent): PetDispatchMessage | null {
  if (event.type !== 'message.completed') return null;
  const { requestId: _requestId, ...message } = event;
  return message;
}

/**
 * Observation-only lifecycle for one admitted dispatch. This is not an Agent
 * execution handle: callers cannot cancel, resume, or read model output here.
 */
export type PetDispatchLifecycleEvent = {
  /** Independent answer to the interrupt left by this earlier dispatch. */
  resumesDispatchId?: string;
  /** Public source identity for read-only correlation, not execution context. */
  origin?: PetInvocationScope;
  dispatchId: string;
  request: string;
  state: PetDispatchLifecycleState;
  requestId?: string;
  error?: string;
  sessionId?: string;
  reply?: string;
  /** Present only on `message`, which never changes the dispatch's state. */
  message?: PetDispatchMessage;
  scope?: PetInvocationScope;
  pendingInterrupt?: PendingInterruptProjection;
};

type ScopedDispatchRequest = Omit<PetDispatchRequest, 'delivery' | 'session' | 'scope'> &
  Required<Pick<PetDispatchRequest, 'scope'>> & { session: { id: string } };

export interface ResidentPetDispatchService {
  getQueueSnapshot(): PetDispatchQueueSnapshot;
  readExecution(target: PetDispatchTarget): PetDispatchExecution;
  onQueueChange(listener: (snapshot: PetDispatchQueueSnapshot) => void): () => void;
  onDispatchLifecycle(listener: (event: PetDispatchLifecycleEvent) => void): () => void;
  /** Accept one-way input for resident execution, which is observed through Agent Session. */
  dispatch(request: PetDispatchRequest): Promise<void>;
  /** Request cancellation of a coordinator-started execution. A true receipt is not settlement. */
  stop(dispatchId: string): boolean;
  /** Admit at the tail and supersede exactly the named pending items in the same scope and Session. */
  supersede(
    request: ScopedDispatchRequest,
    options: { pendingDispatchIds: readonly string[]; stopDispatchId?: string },
  ): Promise<{ stop: 'not_requested' | 'requested' | 'not_active' }>;
}

/** The capabilities exposed to callers that only observe and submit, such as Studio. */
export type PetDispatchPort = Pick<ResidentPetDispatchService,
  'getQueueSnapshot' | 'onQueueChange' | 'onDispatchLifecycle' | 'dispatch'> &
  Partial<Pick<ResidentPetDispatchService, 'readExecution'>>;

export interface ResidentPet {
  readonly dispatch: ResidentPetDispatchService;
  close(): Promise<void>;
}

export interface AgentSessionPeer {
  isConnected(): boolean;
  send(message: AgentServerMessage): boolean;
}

export interface ResidentPetInteraction {
  snapshot(): Promise<AgentServerMessage>;
  getQueueSnapshot(): PetDispatchQueueSnapshot;
  subscribe(listener: (message: AgentServerMessage) => void): () => void;
  request(message: AgentClientMessage): Promise<void>;
  connect(peer: AgentSessionPeer): Promise<void> | void;
  handle(peer: AgentSessionPeer, message: AgentClientMessage): Promise<void>;
  disconnect(peer: AgentSessionPeer): Promise<void> | void;
  close(): Promise<void>;
}

/** A human-review answer addressed to one session's current interrupt. */
export type PetSessionReviewRequest = {
  requestId: string;
  interruptId: string;
  value: { decisions: HumanReviewResponse[] };
};

/**
 * Exact-session observation, plus the one write it allows: answering that
 * session's current review.
 *
 * Nothing here selects, creates, or resumes a session, and observing claims
 * no interactive connection. A session is addressed by id and never falls
 * back to the active one.
 */
/** How much of a session's timeline a read carries. */
export type PetSessionReadOptions = {
  /** Only the newest entries; omitted, the whole timeline. */
  timelineLimit?: number;
};

export interface PetSessionPort {
  /** The session's authoritative snapshot. */
  snapshot(sessionId: string, options?: PetSessionReadOptions): Promise<AgentSessionSnapshot>;
  /**
   * Follow one session. The first message is a `session.snapshot.result`;
   * every later one is a message of that session only, in order. Messages
   * published while the snapshot is read are delivered after it, not lost.
   */
  observe(
    sessionId: string,
    listener: (message: AgentServerMessage) => void,
    options?: PetSessionReadOptions,
  ): Promise<() => void>;
  /**
   * Hand a review answer to the Host. Resolves once the Host owns it, not
   * when the review takes effect: the outcome (a resumed run, or an error)
   * arrives on the session's observation under the same requestId. An answer
   * the Host can already tell it will not run (the review is no longer
   * current, or the Pet is running another turn) is refused here instead,
   * with a `PetSessionReviewRefusedError`.
   */
  review(sessionId: string, request: PetSessionReviewRequest): Promise<void>;
}

export interface ResidentPetHost {
  readonly resident: ResidentPet;
  readonly interaction: ResidentPetInteraction;
  readonly sessions: PetSessionPort;
  close(): Promise<void>;
}

export type MaybePromise<T> = T | Promise<T>;

export type ResidentPetCoordinatorOptions = {
  initialState?: PetDispatchSettledState;
  /** Read the authoritative active-thread checkpoint after an operation settles. */
  readSettledState: () => MaybePromise<PetDispatchState>;
  hasActiveRun?: () => boolean;
  logError?: (message: string, error: unknown) => void;
};

export type QueuedOperation = {
  kind: 'conversation' | 'dispatch';
  ready?: () => Promise<boolean>;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  observation?: PetDispatchQueueEntry;
  stop?: () => boolean;
  confirmStop?: () => Promise<void>;
  onSuperseded?: () => void;
};

/** A second interactive client tried to attach to a Host that already has one. */
export class ResidentPetInteractionBusyError extends Error {
  readonly code = 'interaction_busy';

  constructor(
    message = 'This Pet already has an interactive client. Use dispatch for additional input.',
  ) {
    super(message);
    this.name = 'ResidentPetInteractionBusyError';
  }
}

/** The addressed session does not exist or belongs to another Pet. */
export class PetSessionNotFoundError extends Error {
  readonly code = 'session_not_found';

  constructor(sessionId: string) {
    super(`Session "${sessionId}" does not exist for this Pet.`);
    this.name = 'PetSessionNotFoundError';
  }
}

/**
 * A review answer refused before the Host took it: `review_closed` when the
 * answered review is not the session's current one, `session_busy` when the
 * Pet is running a turn or already resuming another answer.
 */
export class PetSessionReviewRefusedError extends Error {
  constructor(readonly code: 'review_closed' | 'session_busy', message: string) {
    super(message);
    this.name = 'PetSessionReviewRefusedError';
  }
}

/** A dispatch was rejected before admission. */
export class PetDispatchRefusedError extends Error {
  constructor(message = 'The resident dispatch slot or target session is not ready.') {
    super(message);
    this.name = 'PetDispatchRefusedError';
  }
}

export class ResidentPetOperationCancelledError extends Error {
  constructor(message = 'Resident Pet operation was cancelled before it started.') {
    super(message);
    this.name = 'ResidentPetOperationCancelledError';
  }
}
