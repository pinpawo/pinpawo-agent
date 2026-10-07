import type { PetInvocationScope } from './petInvocationContext';
import type {
  PendingInterruptProjection,
  AgentClientMessage,
  AgentRuntimeEvent,
  AgentServerMessage,
  AgentSessionSnapshot,
  AgentToolCallMessageEvent,
  AgentToolCallSettledEvent,
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
  dispatchId: string;
  enqueuedAt: string;
  sessionId?: string;
  scope?: PetInvocationScope;
};

/**
 * An opaque caller correlation key. The resident runtime does not interpret it;
 * it only returns the same key in lifecycle observations.
 */
export type PetDispatchRequest = {
  request: string;
  dispatchId?: string;
  /** Explicit durable session; create only when registering a reserved identity. */
  session?: { id: string; create?: boolean };
  /** Explicit Host-admitted domain scope, independent of the Agent Session. */
  scope?: PetInvocationScope;
};

export type PetDispatchLifecycleState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'interrupted'
  | 'failed'
  /** Non-terminal: the running dispatch's conversation gained or settled a tool call. */
  | 'message';

/** A conversation message event of the dispatch's run, as Agent Session carries it. */
export type PetDispatchMessage =
  | Omit<AgentToolCallMessageEvent, 'requestId'>
  | Omit<AgentToolCallSettledEvent, 'requestId'>;

/** Narrow a runtime event to what dispatch observers see of the conversation. */
export function readPetDispatchMessage(event: AgentRuntimeEvent): PetDispatchMessage | null {
  if (event.type !== 'message.tool_calls' && event.type !== 'tool_call.settled') return null;
  const { requestId: _requestId, ...message } = event;
  return message;
}

/**
 * Observation-only lifecycle for one admitted dispatch. This is not an Agent
 * execution handle: callers cannot cancel, resume, or read model output here.
 */
export type PetDispatchLifecycleEvent = {
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

export interface PetDispatchPort {
  getQueueSnapshot(): PetDispatchQueueSnapshot;
  onQueueChange(listener: (snapshot: PetDispatchQueueSnapshot) => void): () => void;
  onDispatchLifecycle(listener: (event: PetDispatchLifecycleEvent) => void): () => void;
  /** Accept one-way input into the resident queue. Execution is observed through Agent Session. */
  dispatch(request: PetDispatchRequest): Promise<void>;
}

export interface ResidentPet {
  readonly dispatch: PetDispatchPort;
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
export interface PetSessionPort {
  /** The session's authoritative snapshot. */
  snapshot(sessionId: string): Promise<AgentSessionSnapshot>;
  /**
   * Follow one session. The first message is a `session.snapshot.result`;
   * every later one is a message of that session only, in order. Messages
   * published while the snapshot is read are delivered after it, not lost.
   */
  observe(
    sessionId: string,
    listener: (message: AgentServerMessage) => void,
  ): Promise<() => void>;
  /**
   * Hand a review answer to the Host. Resolves once the Host owns it, not
   * when the review takes effect: the outcome (a resumed run, or a
   * closed/stale/wrong-session error) arrives on the session's observation
   * under the same requestId.
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
  logError?: (message: string, error: unknown) => void;
};

export type QueuedOperation = {
  kind: 'conversation' | 'dispatch';
  ready?: () => Promise<boolean>;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  observation?: PetDispatchQueueEntry;
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

export class ResidentPetOperationCancelledError extends Error {
  constructor(message = 'Resident Pet operation was cancelled before it started.') {
    super(message);
    this.name = 'ResidentPetOperationCancelledError';
  }
}
