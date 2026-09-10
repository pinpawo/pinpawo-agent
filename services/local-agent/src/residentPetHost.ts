import { randomUUID } from 'node:crypto';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import {
  buildAgentEventEnvelope,
  type AgentClientMessage,
  type AgentRunView,
  type AgentRuntimeEvent,
  type AgentServerMessage,
} from '@pinpawo/agent-session';
import {
  type AgentCapability,
  type CapabilityArtifactStore,
  type PetDocument,
  type ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';

import type { AgentChannelSetup } from './agentChannel';
import { LocalAgentGraphService } from './agentGraphService';
import { projectPendingInterrupt } from './conversation/pendingInterruptProjection';
import {
  runAgentSessionTurn,
  type AgentSessionTurnOptions,
  type AgentSessionTurnResult,
} from './chatSessionAdapter';
import { loadAgentContext } from './contextLoader';
import { createLocalServerHandlers, type ServerHandlerOptions } from './serverHandlers';
import {
  dispatchLocalServerMessage,
  type LocalServerPeerHandlers,
} from './wire/messageDispatcher';
import { ServerTuiSessionService, type TuiSessionCheckpointer } from './serverTuiSessions';
import {
  createLocalServerRuntimeDepsStore,
  type ServerDeps,
  type ServerRuntimeDepsStore,
} from './serverTypes';
import type { HostExecutionConfig } from './hostExecutionConfig';
import type { HostToolkitInventoryStore } from './toolkits/toolkitInventory';
import type { LocalModelProfileRegistry } from './llmConfig';
import {
  configureInflightOperationRegistry,
  createInflightOperationRun,
  finishInflightOperations,
  overlayInflightDelegationOperations,
} from './inflightOperationRun';
import { emitLocalServerToolOperationEvent } from './serverOperationEvents';
import { createOperationRegistryForAgentSetup } from './runtimeOperationRegistry';

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

type MaybePromise<T> = T | Promise<T>;

export type ResidentPetCoordinatorOptions = {
  initialState?: PetDispatchSettledState;
  /** Read the authoritative active-thread checkpoint after an operation settles. */
  readSettledState: () => MaybePromise<PetDispatchState>;
  logError?: (message: string, error: unknown) => void;
};

type QueuedOperation = {
  kind: 'conversation' | 'dispatch';
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export class ResidentPetOperationCancelledError extends Error {
  constructor(message = 'Resident Pet operation was cancelled before it started.') {
    super(message);
    this.name = 'ResidentPetOperationCancelledError';
  }
}

function defaultLogError(message: string, error: unknown): void {
  console.error(message, error instanceof Error ? error.message : error);
}

/** One non-preemptive graph admission point shared by conversation and dispatch. */
export class ResidentPetCoordinator {
  private readonly dispatchQueue: QueuedOperation[] = [];
  /** Conversations currently holding the gate busy; they never enter a queue. */
  private conversations = 0;
  private readonly listeners = new Set<(state: PetDispatchState) => void>();
  private readonly queueListeners = new Set<(snapshot: PetDispatchQueueSnapshot) => void>();
  private readonly readSettledState: ResidentPetCoordinatorOptions['readSettledState'];
  private readonly logError: NonNullable<ResidentPetCoordinatorOptions['logError']>;
  private state: PetDispatchState;
  private active: Promise<void> | null = null;
  private activeOperation: PetDispatchQueueSnapshot['activeOperation'] = null;
  private refreshing: Promise<PetDispatchState> | null = null;
  private closing = false;

  constructor(options: ResidentPetCoordinatorOptions) {
    this.state = options.initialState ?? 'open';
    this.readSettledState = options.readSettledState;
    this.logError = options.logError ?? defaultLogError;
  }

  getState(): PetDispatchState {
    return this.state;
  }

  getQueueSnapshot(): PetDispatchQueueSnapshot {
    return {
      state: this.state,
      activeOperation: this.activeOperation,
      // Conversations hold the gate but never queue, so this is the count of
      // conversations currently holding it. Kept because StudioDispatchQueue
      // publishes the field.
      queuedConversations: this.conversations,
      queuedDispatches: this.dispatchQueue.length,
    };
  }

  onStateChange(listener: (state: PetDispatchState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onQueueChange(listener: (snapshot: PetDispatchQueueSnapshot) => void): () => void {
    this.queueListeners.add(listener);
    return () => this.queueListeners.delete(listener);
  }

  /**
   * Run a conversation operation while holding the gate busy.
   *
   * Conversation does not join the dispatch queue. dispatch is Studio's
   * scheduling concept and this coordinator is the gate that answers "can
   * this Agent take new work"; conversation is not a competitor for that
   * gate, it is one of the reasons the Agent becomes busy. Conversation has
   * its own admission (SessionAdmission) and thread-level coordination
   * (ThreadInvocationCoordinator), so queueing it here would be a second,
   * unrelated queue.
   *
   * The gate is still held for the operation's duration and refreshed after
   * it settles, so a dispatch cannot start mid-conversation and a pending
   * interrupt raised by the conversation leaves the gate `waiting`.
   */
  async holdForConversation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) {
      throw new ResidentPetOperationCancelledError('Resident Pet Host is closing.');
    }
    // The hold is claimed synchronously, before waiting out an active
    // dispatch. A queued dispatch reads Session state when it starts, so a
    // session switch already in flight has to land first — waiting before
    // claiming would let that dispatch drain against the old thread.
    this.conversations += 1;
    try {
      while (this.active) {
        await this.active;
      }
    } catch {
      // The active operation's own caller owns its failure.
    }
    this.setState('busy');
    this.publishQueueSnapshot();
    let value: T;
    try {
      value = await operation();
    } finally {
      this.conversations -= 1;
      if (this.conversations === 0) {
        this.publishQueueSnapshot();
      }
    }
    // Awaited, not fire-and-forget: callers rely on the gate being settled by
    // the time the operation resolves, the way the queue's own run() refreshed
    // before resolving. A failed refresh leaves the gate `blocked` and is
    // logged rather than failing the conversation, which already succeeded.
    if (this.conversations === 0) {
      try {
        await this.refreshState();
      } catch (error) {
        this.logError('[resident-pet] failed to refresh state after a conversation:', error);
      }
    }
    return value;
  }

  enqueueDispatch<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(operation);
  }

  /** Accept a one-way dispatch and own every later execution outcome inside the runtime. */
  submitDispatch(operation: () => Promise<void>): void {
    if (this.closing) {
      throw new ResidentPetOperationCancelledError('Resident Pet Host is closing.');
    }
    void this.enqueue(operation).catch((error) => {
      if (error instanceof ResidentPetOperationCancelledError) return;
      this.logError('[resident-pet] dispatch execution failed:', error);
    });
    // A pending review can be resolved through a reconnect or another
    // session client. Do not let the queue keep that old settled state and
    // strand a later one-way dispatch behind it.
    void this.refreshState().catch((error) => {
      this.logError('[resident-pet] failed to refresh dispatch admission state:', error);
    });
  }

  async refreshState(): Promise<PetDispatchState> {
    if (this.active) return this.state;
    if (this.refreshing) return this.refreshing;
    const refreshing = Promise.resolve().then(async () => {
      try {
        const next = await this.readNextSettledState();
        this.setState(next);
        return next;
      } catch (error) {
        this.setState('blocked');
        throw error;
      }
    });
    this.refreshing = refreshing;
    try {
      return await refreshing;
    } finally {
      if (this.refreshing === refreshing) this.refreshing = null;
      this.drain();
    }
  }

  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      this.cancelQueue(this.dispatchQueue);
    }
    await Promise.all([this.active, this.refreshing]);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(new ResidentPetOperationCancelledError());
    }
    return new Promise<T>((resolve, reject) => {
      this.dispatchQueue.push({
        kind: 'dispatch',
        run: operation,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.publishQueueSnapshot();
      this.drain();
    });
  }

  private drain(): void {
    // A conversation holding the gate keeps dispatch waiting, same as an
    // active dispatch does.
    if (this.active || this.refreshing || this.closing || this.conversations > 0) return;
    const entry = this.state === 'open' ? this.dispatchQueue.shift() : undefined;
    if (!entry) return;
    this.activeOperation = entry.kind;
    const active = Promise.resolve().then(() => this.run(entry));
    this.active = active;
    this.setState('busy');
    void active.then(() => {
      if (this.active === active) {
        this.active = null;
        this.activeOperation = null;
        this.publishQueueSnapshot();
      }
      this.drain();
    });
  }

  private async run(entry: QueuedOperation): Promise<void> {
    let value: unknown;
    let operationError: unknown;
    try {
      value = await entry.run();
    } catch (error) {
      operationError = error;
    }
    try {
      this.setState(await this.readNextSettledState());
    } catch (error) {
      this.setState('blocked');
      if (operationError === undefined) operationError = error;
      else this.logError('[resident-pet] failed to refresh settled state:', error);
    }
    if (operationError !== undefined) entry.reject(operationError);
    else entry.resolve(value);
  }

  private async readNextSettledState(): Promise<PetDispatchSettledState> {
    const next = await this.readSettledState();
    if (next === 'busy') {
      throw new Error('Resident Pet remained busy after its active operation settled.');
    }
    return next;
  }

  private setState(next: PetDispatchState): void {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (error) {
        this.logError('[resident-pet] state listener failed:', error);
      }
    }
    // The active operation clears immediately after its settled state is read.
    // Publish that single coherent snapshot from the completion callback instead
    // of briefly reporting an idle state while an operation is still active.
    if (this.active && next !== 'busy') return;
    this.publishQueueSnapshot();
  }

  private publishQueueSnapshot(): void {
    const snapshot = this.getQueueSnapshot();
    for (const listener of this.queueListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logError('[resident-pet] queue listener failed:', error);
      }
    }
  }

  private cancelQueue(queue: QueuedOperation[]): void {
    for (const entry of queue.splice(0)) {
      entry.reject(new ResidentPetOperationCancelledError('Resident Pet Host is closing.'));
    }
    this.publishQueueSnapshot();
  }
}

export type CreateResidentPetRuntimeOptions = HostExecutionConfig & {
  /** Host identity used for session ownership and graph isolation. */
  petId: string;
  petName: string;
  /** Optional attribution passed to Host tracing, outside the Agent contract. */
  traceUserId?: string;
  modelProfiles: LocalModelProfileRegistry;
  modelProfileId?: string;
  defaultCapabilityName?: string;
  petDocument?: PetDocument;
  capabilities: readonly AgentCapability[];
  toolkitInventory: HostToolkitInventoryStore;
  toolkitRuntimeManager?: ToolkitRuntimeManager;
  capabilityArtifactStore: CapabilityArtifactStore;
  checkpointer: TuiSessionCheckpointer;
  /** Pet-scoped Agent Session registry path owned by the composing Host. */
  sessionStatePath: string;
  loadContext?: typeof loadAgentContext;
  graphService?: LocalAgentGraphService;
  /** Shared Agent Session turn runner used by conversation and headless input. */
  runAgentTurn?: (options: AgentSessionTurnOptions) => Promise<AgentSessionTurnResult>;
  /** Host persistence port for updated startup defaults. */
  persistGlobalReviewPolicyMode?: ServerHandlerOptions['persistGlobalReviewPolicyMode'];
  /** Existing opaque checkpoint thread, adopted only when no Agent Session exists. */
  adoptThreadId?: string;
};

export type CreateResidentPetHostOptions = CreateResidentPetRuntimeOptions;

declare const residentPetRuntimeBrand: unique symbol;

/** Opaque shared runtime context used to derive either resident surface. */
export interface ResidentPetRuntime {
  readonly petId: string;
  readonly [residentPetRuntimeBrand]: never;
}

type ResidentPetRuntimeContext = {
  runtime: ResidentPetRuntime;
  runtimeDeps: ServerRuntimeDepsStore;
  graphService: LocalAgentGraphService;
  runAgentTurn: (options: AgentSessionTurnOptions) => Promise<AgentSessionTurnResult>;
  loadContext: typeof loadAgentContext;
  sessions: ServerTuiSessionService;
  coordinator: ResidentPetCoordinator;
  localHandlers: ReturnType<typeof createLocalServerHandlers>;
  peerHandlers: LocalServerPeerHandlers;
  peers: Set<AgentSessionPeer>;
  publishRuntimeEvent: (event: AgentRuntimeEvent) => void;
  dispatchLifecycleListeners: Set<(event: PetDispatchLifecycleEvent) => void>;
  publishDispatchLifecycle: (event: PetDispatchLifecycleEvent) => void;
  activeHostRuns: Map<string, AbortController>;
  beginActiveRun: (requestId: string) => ResidentActiveRun;
  finishActiveRun: (run: ResidentActiveRun) => void;
  close: () => Promise<void>;
  isClosing: () => boolean;
};

type ResidentActiveRun = Extract<AgentRunView, { state: 'running' }>;

const residentPetRuntimeContexts = new WeakMap<object, ResidentPetRuntimeContext>();

function readResidentPetRuntimeContext(runtime: ResidentPetRuntime): ResidentPetRuntimeContext {
  const context = residentPetRuntimeContexts.get(runtime);
  if (!context) {
    throw new Error('Resident Pet runtime was not created by this local-agent runtime.');
  }
  return context;
}

function withDefaultModelProfile(
  registry: LocalModelProfileRegistry,
  modelProfileId: string | undefined,
): LocalModelProfileRegistry {
  if (!modelProfileId || modelProfileId === registry.defaultProfileId) return registry;
  registry.resolve(modelProfileId);
  return Object.freeze({ ...registry, defaultProfileId: modelProfileId });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function admitConversationHandlers(
  handlers: LocalServerPeerHandlers,
  coordinator: ResidentPetCoordinator,
  activeRuns: {
    begin: (requestId: string) => ResidentActiveRun;
    finish: (run: ResidentActiveRun) => void;
  },
): LocalServerPeerHandlers {
  // Conversation no longer enters the dispatch queue; it holds the gate for
  // its duration so a dispatch cannot start mid-conversation. Its own
  // admission and ordering live in the local layer (SessionAdmission,
  // ServerSessionCommandQueue, ThreadInvocationCoordinator).
  const admit = <TMessage>(
    handler: (peer: AgentSessionPeer, message: TMessage) => MaybePromise<void>,
  ) => (peer: AgentSessionPeer, message: TMessage) => coordinator.holdForConversation(
    () => Promise.resolve(handler(peer, message)),
  );
  const admitRun = <TMessage extends { requestId: string }>(
    handler: (peer: AgentSessionPeer, message: TMessage) => MaybePromise<void>,
  ) => (peer: AgentSessionPeer, message: TMessage) => coordinator.holdForConversation(
    async () => {
      const activeRun = activeRuns.begin(message.requestId);
      try {
        await handler(peer, message);
      } finally {
        activeRuns.finish(activeRun);
      }
    },
  );
  return {
    onChatRequest: admitRun(handlers.onChatRequest),
    onInterruptResume: admitRun(handlers.onInterruptResume),
    // These controls must reach the active conversation instead of waiting
    // behind it in the same queue.
    onRunInterrupt: handlers.onRunInterrupt,
    onNewSession: admit(handlers.onNewSession),
    onRuntimeConfigUpdate: admit(handlers.onRuntimeConfigUpdate),
    // Snapshot is observational and already serialized per peer by the local
    // handler. It must remain reachable while a resident operation is active.
    onSessionSnapshotGet: handlers.onSessionSnapshotGet,
    onSessionList: admit(handlers.onSessionList),
    ...(handlers.onSessionCompact ? { onSessionCompact: admit(handlers.onSessionCompact) } : {}),
    onSessionNew: admit(handlers.onSessionNew),
    onSessionResume: admit(handlers.onSessionResume),
    onModelList: admit(handlers.onModelList),
    onModelSelect: admit(handlers.onModelSelect),
    onClose: handlers.onClose,
    ...(handlers.log ? { log: handlers.log } : {}),
    ...(handlers.logError ? { logError: handlers.logError } : {}),
    ...(handlers.logWarn ? { logWarn: handlers.logWarn } : {}),
  };
}

/** Build the Pet-scoped graph/session/Coordinator without constructing a transport. */
export async function createResidentPetRuntime(
  options: CreateResidentPetRuntimeOptions,
): Promise<ResidentPetRuntime> {
  const modelProfiles = withDefaultModelProfile(options.modelProfiles, options.modelProfileId);
  const deps: ServerDeps & {
    chatCheckpointer: TuiSessionCheckpointer;
    capabilityArtifactStore: CapabilityArtifactStore;
  } = {
    serverMode: 'chat',
    petId: options.petId,
    petName: options.petName,
    modelProfiles,
    runtimeConfig: options.runtimeConfig,
    globalReviewPolicyMode: options.globalReviewPolicyMode,
    autoAuthorizationSafetyLevel: options.autoAuthorizationSafetyLevel,
    chatCheckpointer: options.checkpointer,
    toolkitInventory: options.toolkitInventory,
    ...(options.toolkitRuntimeManager ? { toolkitRuntimeManager: options.toolkitRuntimeManager } : {}),
    capabilityCatalog: {
      getSnapshot: () => ({ capabilities: options.capabilities }),
    },
    ...(options.defaultCapabilityName
      ? { defaultCapabilityName: options.defaultCapabilityName }
      : {}),
    ...(options.petDocument ? { petDocument: options.petDocument } : {}),
    capabilityArtifactStore: options.capabilityArtifactStore,
  };
  const runtimeDeps = createLocalServerRuntimeDepsStore(deps);
  const graphService = options.graphService ?? new LocalAgentGraphService();
  const loadContext = options.loadContext
    ?? (async () => ({
      pet: { id: options.petId, name: options.petName },
      traceUserId: options.traceUserId,
    }));
  const sessions = new ServerTuiSessionService({
    graphService,
    loadContext,
    runtimeConfig: deps.runtimeConfig,
    sessionStatePath: options.sessionStatePath,
    checkpointer: options.checkpointer,
    defaultModelProfileId: deps.modelProfiles.defaultProfileId,
  });

  if (!sessions.hasActiveSession(deps.petId) && options.adoptThreadId) {
    const legacy = await options.checkpointer.getTuple({
      configurable: { thread_id: options.adoptThreadId },
    });
    if (legacy) sessions.adoptInitialThread(deps.petId, options.adoptThreadId);
  }
  sessions.getActiveSession(deps.petId);

  const readSettledState = async (): Promise<PetDispatchSettledState> => {
    const context = await loadContext(deps.petId);
    const setup = sessions.buildChatSetup(runtimeDeps.get(), context);
    const state = await graphService.readThreadState(setup);
    // Any pending interrupt holds dispatch, whatever its kind. Resumability
    // is not consulted: it cannot tell a paused task from ordinary retained
    // work, and the interrupt is the authoritative signal.
    if (state.pendingInterrupt) return 'waiting';
    return 'open';
  };
  const coordinator = new ResidentPetCoordinator({ readSettledState });
  const peers = new Set<AgentSessionPeer>();
  const dispatchLifecycleListeners = new Set<(event: PetDispatchLifecycleEvent) => void>();
  const activeHostRuns = new Map<string, AbortController>();
  let activeRun: ResidentActiveRun | null = null;
  const beginActiveRun = (requestId: string): ResidentActiveRun => {
    if (activeRun) {
      throw new Error(`Resident Pet already has active run "${activeRun.requestId}".`);
    }
    const next: ResidentActiveRun = {
      requestId,
      state: 'running',
      activity: 'thinking',
      startedAt: Date.now(),
    };
    activeRun = next;
    return next;
  };
  const finishActiveRun = (run: ResidentActiveRun) => {
    if (activeRun === run) activeRun = null;
  };
  const publishRuntimeEvent = (event: AgentRuntimeEvent) => {
    const message = buildAgentEventEnvelope(event);
    for (const peer of peers) {
      if (!peer.isConnected()) continue;
      try {
        peer.send(message);
      } catch (error) {
        defaultLogError('[resident-pet] failed to publish Agent Session event:', error);
      }
    }
  };
  const publishDispatchLifecycle = (event: PetDispatchLifecycleEvent) => {
    for (const listener of dispatchLifecycleListeners) {
      try {
        listener(event);
      } catch (error) {
        defaultLogError('[resident-pet] dispatch lifecycle listener failed:', error);
      }
    }
  };
  const runAgentTurn = options.runAgentTurn ?? runAgentSessionTurn;
  const localHandlers = createLocalServerHandlers(runtimeDeps, {
    persistGlobalReviewPolicyMode: options.persistGlobalReviewPolicyMode,
    chatGraphService: graphService,
    tuiSessions: sessions,
    loadContext,
    runAgentTurn,
    publishRuntimeEvent: (_origin, event) => publishRuntimeEvent(event),
    readActiveRun: () => activeRun,
    interruptHostRun: (requestId) => {
      const controller = activeHostRuns.get(requestId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
  });
  const peerHandlers = admitConversationHandlers(localHandlers.peerHandlers, coordinator, {
    begin: beginActiveRun,
    finish: finishActiveRun,
  });
  let closing: Promise<void> | null = null;

  const runtime = Object.freeze({
    petId: deps.petId,
  }) as ResidentPetRuntime;

  const close = () => {
    closing ??= (async () => {
      for (const controller of activeHostRuns.values()) controller.abort();
      await Promise.allSettled([...peers].map((peer) => peerHandlers.onClose(peer)));
      peers.clear();
      await coordinator.close();
      localHandlers.close();
    })();
    return closing;
  };

  const context: ResidentPetRuntimeContext = {
    runtime,
    runtimeDeps,
    graphService,
    runAgentTurn,
    loadContext,
    sessions,
    coordinator,
    localHandlers,
    peerHandlers,
    peers,
    publishRuntimeEvent,
    dispatchLifecycleListeners,
    publishDispatchLifecycle,
    activeHostRuns,
    beginActiveRun,
    finishActiveRun,
    close,
    isClosing: () => closing !== null,
  };
  residentPetRuntimeContexts.set(runtime, context);
  await coordinator.refreshState();
  return runtime;
}

/** Derive the one-way dispatch surface from an existing resident runtime. */
export function createResidentPet(runtime: ResidentPetRuntime): ResidentPet {
  const context = readResidentPetRuntimeContext(runtime);
  const {
    coordinator,
    runtimeDeps,
    graphService,
    runAgentTurn,
    loadContext,
    sessions,
    publishRuntimeEvent,
    dispatchLifecycleListeners,
    publishDispatchLifecycle,
    activeHostRuns,
    beginActiveRun,
    finishActiveRun,
  } = context;

  const dispatch: PetDispatchPort = {
    getQueueSnapshot: () => coordinator.getQueueSnapshot(),
    onQueueChange: (listener) => coordinator.onQueueChange(listener),
    onDispatchLifecycle: (listener) => {
      dispatchLifecycleListeners.add(listener);
      return () => dispatchLifecycleListeners.delete(listener);
    },
    dispatch: async ({ request, dispatchId: suppliedDispatchId }) => {
      const dispatchId = suppliedDispatchId?.trim() || randomUUID();
      coordinator.submitDispatch(() => AsyncLocalStorageProviderSingleton.runWithConfig(
        { callbacks: [] },
        async () => {
          // A Plugin can submit the next Pet while still inside the current Pet's
          // LangChain tool/event callback. This admitted dispatch is a new
          // one-way Agent root, not a child model run, so it must not inherit the
          // caller's callbacks/run id.
          const requestId = `host-${randomUUID()}`;
          const run = createInflightOperationRun(requestId);
          let activeRun: ResidentActiveRun | null = null;
          let abortedSetup: AgentChannelSetup | null = null;
          /**
           * A cancelled dispatch that left work behind becomes a task pause,
           * so resident runs are continuable by id exactly like Chat runs.
           */
          const settleInterruptedDispatch = async (params: {
            setup: AgentChannelSetup | null;
            announce?: boolean;
          }) => {
            finishInflightOperations(run, 'interrupted', publishRuntimeEvent);
            // A settlement that fails leaves the thread in an unknown state,
            // so it takes the dispatch's failure path instead of being
            // reported as a clean interruption.
            const settled = params.setup
              ? await graphService.settleAbortedRun(params.setup)
              : null;
            if (settled) {
              publishRuntimeEvent({
                type: 'interrupt.requested',
                requestId,
                pendingInterrupt: projectPendingInterrupt(settled),
              });
              publishDispatchLifecycle({ dispatchId, request, requestId, state: 'waiting' });
              return;
            }
            if (params.announce !== false) {
              publishRuntimeEvent({
                type: 'run.interrupted',
                requestId,
                message: 'Run interrupted.',
              });
            }
            publishDispatchLifecycle({ dispatchId, request, requestId, state: 'interrupted' });
          };
          try {
            const context = await loadContext(runtimeDeps.get().petId);
            const setup = sessions.buildChatSetup(runtimeDeps.get(), context);
            abortedSetup = setup;
            configureInflightOperationRegistry(
              run,
              createOperationRegistryForAgentSetup(setup),
            );
            setup.input.signal = run.controller.signal;
            activeHostRuns.set(requestId, run.controller);
            activeRun = beginActiveRun(requestId);
            publishDispatchLifecycle({ dispatchId, request, requestId, state: 'running' });
            publishRuntimeEvent({
              type: 'run.started',
              requestId,
              initiator: 'host',
              input: { role: 'user', text: request },
            });
            const result = await runAgentTurn({
              request: { kind: 'user_message', requestId, message: request },
              setup,
              graphService,
              isCurrent: () => !run.controller.signal.aborted,
              emitEvent: publishRuntimeEvent,
              emitToolEvent: (payload) => {
                emitLocalServerToolOperationEvent({
                  run,
                  payload,
                  emit: publishRuntimeEvent,
                });
              },
              acceptDelegationOperations: (operations) => {
                overlayInflightDelegationOperations(run, operations);
              },
            });
            if (result.status === 'waiting') {
              finishInflightOperations(run, 'interrupted', publishRuntimeEvent);
              publishDispatchLifecycle({ dispatchId, request, requestId, state: 'waiting' });
              return;
            }
            if (result.status === 'interrupted') {
              await settleInterruptedDispatch({ setup });
              return;
            }
            finishInflightOperations(run, 'completed', publishRuntimeEvent);
            publishDispatchLifecycle({ dispatchId, request, requestId, state: 'completed' });
          } catch (error) {
            let failure = error;
            if (run.controller.signal.aborted || isAbortError(error)) {
              try {
                await settleInterruptedDispatch({
                  setup: abortedSetup,
                  announce: activeRun !== null,
                });
                return;
              } catch (settleError) {
                console.error(
                  '[resident-pet] failed to settle an aborted dispatch:',
                  settleError instanceof Error
                    ? (settleError.stack ?? settleError.message)
                    : settleError,
                );
                failure = settleError;
              }
            }
            finishInflightOperations(run, 'failed', publishRuntimeEvent, failure);
            const message = failure instanceof Error ? failure.message : 'internal error';
            if (activeRun) {
              publishRuntimeEvent({
                type: 'error',
                requestId,
                message,
              });
            }
            publishDispatchLifecycle({
              dispatchId,
              request,
              requestId,
              state: 'failed',
              error: message,
            });
            throw failure;
          } finally {
            if (activeHostRuns.get(requestId) === run.controller) {
              activeHostRuns.delete(requestId);
            }
            if (activeRun) finishActiveRun(activeRun);
          }
        },
        true,
      ));
      publishDispatchLifecycle({ dispatchId, request, state: 'queued' });
    },
  };

  return { dispatch, close: context.close };
}

/** Derive the Agent Session adapter independently from the same runtime. */
export function createResidentPetInteraction(
  runtime: ResidentPetRuntime,
): ResidentPetInteraction {
  const context = readResidentPetRuntimeContext(runtime);
  const { peerHandlers, peers } = context;
  const interaction: ResidentPetInteraction = {
    connect: (peer) => {
      if (context.isClosing()) throw new Error('Resident Pet interaction is closed.');
      peers.add(peer);
    },
    handle: async (peer, message) => {
      if (context.isClosing() || !peers.has(peer)) {
        throw new Error('Agent Session peer is not connected to this resident Pet.');
      }
      if (message.type === 'ping') {
        peer.send({ type: 'pong' });
        return;
      }
      await dispatchLocalServerMessage(peer, JSON.stringify(message), peerHandlers);
    },
    disconnect: async (peer) => {
      if (!peers.delete(peer)) return;
      await peerHandlers.onClose(peer);
    },
    close: context.close,
  };

  return interaction;
}

/** Compose the two independently constructible surfaces for a Host owner. */
export async function createResidentPetHost(
  options: CreateResidentPetHostOptions,
): Promise<ResidentPetHost> {
  const runtime = await createResidentPetRuntime(options);
  const resident = createResidentPet(runtime);
  const interaction = createResidentPetInteraction(runtime);
  const { close } = readResidentPetRuntimeContext(runtime);
  return {
    resident,
    interaction,
    close,
  };
}
