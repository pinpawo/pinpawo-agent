import { randomUUID } from 'node:crypto';
import {
  buildAgentEventEnvelope,
  type AgentClientMessage,
  type AgentRuntimeEvent,
  type AgentServerMessage,
} from '@pinpawo/agent-session';
import { DEFAULT_TOOL_AUTHORIZATION_SAFETY_LEVEL } from '@pinpawo/agent-contracts';
import {
  GLOBAL_REVIEW_POLICY_MODE,
  type AgentActor,
  type AgentCapability,
  type CapabilityArtifactStore,
  type ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';

import { LocalAgentGraphService } from './agentGraphService';
import {
  runAgentSessionTurn,
  type AgentSessionTurnOptions,
  type AgentSessionTurnResult,
} from './chatSessionAdapter';
import { loadAgentContext } from './contextLoader';
import { createLocalServerHandlers } from './localServerHandlers';
import {
  dispatchLocalServerMessage,
  type LocalServerPeerHandlers,
} from './localServerMessageDispatcher';
import { LocalServerTuiSessionService, type TuiSessionCheckpointer } from './localServerTuiSessions';
import type { LocalServerDeps } from './localServerTypes';
import type { LocalAgentRuntimeConfig } from './runtimeConfig';
import type { HostToolkitInventoryStore } from './toolkits/toolkitInventory';
import type { LocalModelProfileRegistry } from './llmConfig';
import {
  configureInflightOperationRegistry,
  createInflightOperationRun,
  finishInflightOperations,
  overlayInflightDelegationOperations,
} from './inflightOperationRun';
import { emitLocalServerToolOperationEvent } from './localServerOperationEvents';
import { createOperationRegistryForAgentSetup } from './runtimeOperationRegistry';

export type PetDispatchState = 'open' | 'busy' | 'waiting' | 'blocked';
export type PetDispatchSettledState = Exclude<PetDispatchState, 'busy'>;

export type PetDispatchRequest = { request: string };

export interface PetDispatchPort {
  getState(): PetDispatchState;
  onStateChange(listener: (state: PetDispatchState) => void): () => void;
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
  private readonly conversationQueue: QueuedOperation[] = [];
  private readonly dispatchQueue: QueuedOperation[] = [];
  private readonly listeners = new Set<(state: PetDispatchState) => void>();
  private readonly readSettledState: ResidentPetCoordinatorOptions['readSettledState'];
  private readonly logError: NonNullable<ResidentPetCoordinatorOptions['logError']>;
  private state: PetDispatchState;
  private active: Promise<void> | null = null;
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

  onStateChange(listener: (state: PetDispatchState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  enqueueConversation<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue('conversation', operation);
  }

  enqueueDispatch<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue('dispatch', operation);
  }

  /** Accept a one-way dispatch and own every later execution outcome inside the runtime. */
  submitDispatch(operation: () => Promise<void>): void {
    if (this.closing) {
      throw new ResidentPetOperationCancelledError('Resident Pet Host is closing.');
    }
    void this.enqueue('dispatch', operation).catch((error) => {
      if (error instanceof ResidentPetOperationCancelledError) return;
      this.logError('[resident-pet] dispatch execution failed:', error);
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
      this.cancelQueue(this.conversationQueue);
      this.cancelQueue(this.dispatchQueue);
    }
    await Promise.all([this.active, this.refreshing]);
  }

  private enqueue<T>(
    kind: QueuedOperation['kind'],
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.closing) {
      return Promise.reject(new ResidentPetOperationCancelledError());
    }
    return new Promise<T>((resolve, reject) => {
      const entry: QueuedOperation = {
        kind,
        run: operation,
        resolve: (value) => resolve(value as T),
        reject,
      };
      (kind === 'conversation' ? this.conversationQueue : this.dispatchQueue).push(entry);
      this.drain();
    });
  }

  private drain(): void {
    if (this.active || this.refreshing || this.closing) return;
    const entry = this.conversationQueue.shift()
      ?? (this.state === 'open' ? this.dispatchQueue.shift() : undefined);
    if (!entry) return;
    const active = Promise.resolve().then(() => this.run(entry));
    this.active = active;
    this.setState('busy');
    void active.then(() => {
      if (this.active === active) this.active = null;
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
  }

  private cancelQueue(queue: QueuedOperation[]): void {
    for (const entry of queue.splice(0)) {
      entry.reject(new ResidentPetOperationCancelledError('Resident Pet Host is closing.'));
    }
  }
}

export type CreateResidentPetRuntimeOptions = {
  actor: AgentActor;
  modelProfiles: LocalModelProfileRegistry;
  modelProfileId?: string;
  capabilities: readonly AgentCapability[];
  toolkitInventory: HostToolkitInventoryStore;
  toolkitRuntimeManager?: ToolkitRuntimeManager;
  capabilityArtifactStore: CapabilityArtifactStore;
  checkpointer: TuiSessionCheckpointer;
  runtimeConfig: LocalAgentRuntimeConfig;
  /** Pet-scoped Agent Session registry path owned by the composing Host. */
  sessionStatePath: string;
  loadContext?: typeof loadAgentContext;
  graphService?: LocalAgentGraphService;
  /** Shared Agent Session turn runner used by conversation and headless input. */
  runAgentTurn?: (options: AgentSessionTurnOptions) => Promise<AgentSessionTurnResult>;
  /** @deprecated Use runAgentTurn. */
  runChat?: (options: AgentSessionTurnOptions) => Promise<AgentSessionTurnResult>;
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
  deps: LocalServerDeps;
  graphService: LocalAgentGraphService;
  runAgentTurn: (options: AgentSessionTurnOptions) => Promise<AgentSessionTurnResult>;
  loadContext: typeof loadAgentContext;
  sessions: LocalServerTuiSessionService;
  coordinator: ResidentPetCoordinator;
  localHandlers: ReturnType<typeof createLocalServerHandlers>;
  peerHandlers: LocalServerPeerHandlers;
  peers: Set<AgentSessionPeer>;
  publishRuntimeEvent: (event: AgentRuntimeEvent) => void;
  activeHostRuns: Map<string, AbortController>;
  close: () => Promise<void>;
  isClosing: () => boolean;
};

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

function buildResidentAgentContext(actor: AgentActor) {
  return {
    pet: {
      id: actor.petId,
      name: actor.name,
      personality: actor.personality ?? null,
      species: actor.species ?? null,
      stage: actor.stage ?? null,
      growth_value: null,
      stage_asset_id: null,
    },
    context: {
      petMemoryText: '',
      recentChatTurns: [],
      today: new Date().toISOString().slice(0, 10),
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function admitConversationHandlers(
  handlers: LocalServerPeerHandlers,
  coordinator: ResidentPetCoordinator,
): LocalServerPeerHandlers {
  const admit = <TMessage>(
    handler: (peer: AgentSessionPeer, message: TMessage) => MaybePromise<void>,
  ) => (peer: AgentSessionPeer, message: TMessage) => coordinator.enqueueConversation(
    () => Promise.resolve(handler(peer, message)),
  );
  return {
    onChatRequest: admit(handlers.onChatRequest),
    onHumanReviewResponse: admit(handlers.onHumanReviewResponse),
    onReviewCancel: admit(handlers.onReviewCancel),
    // These controls must reach the active conversation instead of waiting
    // behind it in the same queue.
    onRunInterrupt: handlers.onRunInterrupt,
    onNewSession: admit(handlers.onNewSession),
    onRuntimeConfigUpdate: admit(handlers.onRuntimeConfigUpdate),
    onSessionSnapshotGet: admit(handlers.onSessionSnapshotGet),
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
  const llmConfig = modelProfiles.resolve();
  const deps: LocalServerDeps & {
    chatCheckpointer: TuiSessionCheckpointer;
    capabilityArtifactStore: CapabilityArtifactStore;
  } = {
    serverMode: 'chat',
    actorId: options.actor.petId,
    actorName: options.actor.name,
    modelProfiles,
    globalReviewPolicyMode: llmConfig.globalReviewPolicyMode
      ?? GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION,
    autoAuthorizationSafetyLevel: llmConfig.autoAuthorizationSafetyLevel
      ?? DEFAULT_TOOL_AUTHORIZATION_SAFETY_LEVEL,
    workdir: options.runtimeConfig.workdir,
    runtimeConfig: options.runtimeConfig,
    chatCheckpointer: options.checkpointer,
    toolkitInventory: options.toolkitInventory,
    ...(options.toolkitRuntimeManager ? { toolkitRuntimeManager: options.toolkitRuntimeManager } : {}),
    capabilityCatalog: {
      getSnapshot: () => ({ capabilities: options.capabilities }),
    },
    capabilityArtifactStore: options.capabilityArtifactStore,
  };
  const graphService = options.graphService ?? new LocalAgentGraphService();
  const loadContext = options.loadContext
    ?? (async () => buildResidentAgentContext(options.actor));
  const sessions = new LocalServerTuiSessionService({
    graphService,
    loadContext,
    runtimeConfig: deps.runtimeConfig,
    sessionStatePath: options.sessionStatePath,
    checkpointer: options.checkpointer,
    defaultModelProfileId: deps.modelProfiles.defaultProfileId,
  });

  if (!sessions.hasActiveSession(deps.actorId) && options.adoptThreadId) {
    const legacy = await options.checkpointer.getTuple({
      configurable: { thread_id: options.adoptThreadId },
    });
    if (legacy) sessions.adoptInitialThread(deps.actorId, options.adoptThreadId);
  }
  sessions.getActiveSession(deps.actorId);

  const readSettledState = async (): Promise<PetDispatchSettledState> => {
    const context = await loadContext(deps.actorId);
    const setup = sessions.buildChatSetup(deps, context);
    const state = await graphService.readThreadState(setup);
    if (state.pendingInterrupt) return 'waiting';
    if (state.hasPendingContinuation) return 'blocked';
    return 'open';
  };
  const coordinator = new ResidentPetCoordinator({ readSettledState });
  const peers = new Set<AgentSessionPeer>();
  const activeHostRuns = new Map<string, AbortController>();
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
  const runAgentTurn = options.runAgentTurn ?? options.runChat ?? runAgentSessionTurn;
  const localHandlers = createLocalServerHandlers(deps, {
    chatGraphService: graphService,
    tuiSessions: sessions,
    loadContext,
    runAgentTurn,
    publishRuntimeEvent: (_origin, event) => publishRuntimeEvent(event),
    interruptHostRun: (requestId) => {
      const controller = activeHostRuns.get(requestId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
  });
  const peerHandlers = admitConversationHandlers(localHandlers.peerHandlers, coordinator);
  let closing: Promise<void> | null = null;

  const runtime = Object.freeze({
    petId: deps.actorId,
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
    deps,
    graphService,
    runAgentTurn,
    loadContext,
    sessions,
    coordinator,
    localHandlers,
    peerHandlers,
    peers,
    publishRuntimeEvent,
    activeHostRuns,
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
    deps,
    graphService,
    runAgentTurn,
    loadContext,
    sessions,
    publishRuntimeEvent,
    activeHostRuns,
  } = context;

  const dispatch: PetDispatchPort = {
    getState: () => coordinator.getState(),
    onStateChange: (listener) => coordinator.onStateChange(listener),
    dispatch: async ({ request }) => {
      coordinator.submitDispatch(async () => {
        const context = await loadContext(deps.actorId);
        const setup = sessions.buildChatSetup(deps, context);
        const requestId = `host-${randomUUID()}`;
        const run = createInflightOperationRun(requestId);
        configureInflightOperationRegistry(
          run,
          createOperationRegistryForAgentSetup(setup),
        );
        setup.input.signal = run.controller.signal;
        activeHostRuns.set(requestId, run.controller);
        publishRuntimeEvent({
          type: 'run.started',
          requestId,
          initiator: 'host',
          input: { role: 'user', text: request },
        });
        try {
          const result = await runAgentTurn({
            request: { kind: 'user_message', requestId, message: request },
            setup,
            graphService,
            isCurrent: () => !run.controller.signal.aborted,
            finishInterrupted: () => undefined,
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
          if (result.status === 'waiting_human') {
            finishInflightOperations(run, 'interrupted', publishRuntimeEvent);
            return;
          }
          if (result.status === 'interrupted') {
            finishInflightOperations(run, 'interrupted', publishRuntimeEvent);
            publishRuntimeEvent({
              type: 'run.interrupted',
              requestId,
              message: 'Run interrupted.',
            });
            return;
          }
          finishInflightOperations(run, 'completed', publishRuntimeEvent);
        } catch (error) {
          if (run.controller.signal.aborted || isAbortError(error)) {
            finishInflightOperations(run, 'interrupted', publishRuntimeEvent);
            publishRuntimeEvent({
              type: 'run.interrupted',
              requestId,
              message: 'Run interrupted.',
            });
            return;
          }
          finishInflightOperations(run, 'failed', publishRuntimeEvent, error);
          publishRuntimeEvent({
            type: 'error',
            requestId,
            message: error instanceof Error ? error.message : 'internal error',
          });
          throw error;
        } finally {
          if (activeHostRuns.get(requestId) === run.controller) {
            activeHostRuns.delete(requestId);
          }
        }
      });
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
