import type {
  AgentClientMessage,
  AgentServerMessage,
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
};

/**
 * An opaque caller correlation key. The resident runtime does not interpret it;
 * it only returns the same key in lifecycle observations.
 */
export type PetDispatchRequest = {
  request: string;
  dispatchId?: string;
};

export type PetDispatchLifecycleState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'interrupted'
  | 'failed';

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
  connect(peer: AgentSessionPeer): Promise<void> | void;
  handle(peer: AgentSessionPeer, message: AgentClientMessage): Promise<void>;
  disconnect(peer: AgentSessionPeer): Promise<void> | void;
  close(): Promise<void>;
}

export interface ResidentPetHost {
  readonly resident: ResidentPet;
  readonly interaction: ResidentPetInteraction;
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
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
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

export class ResidentPetOperationCancelledError extends Error {
  constructor(message = 'Resident Pet operation was cancelled before it started.') {
    super(message);
    this.name = 'ResidentPetOperationCancelledError';
  }
}
