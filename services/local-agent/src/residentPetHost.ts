import { randomUUID } from 'node:crypto';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import {
  buildAgentEventEnvelope,
  type AgentClientMessage,
  type AgentRuntimeEvent,
  type AgentServerMessage,
} from '@pinpawo/agent-session';
import { ActiveRunRegister, type ActiveRun } from './agent/activeRunRegister';
import {
  type AgentCapability,
  type CapabilityArtifactStore,
  type PetDocument,
  type ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';

import type { AgentChannelSetup } from './agent/agentChannel';
import { LocalAgentGraphService } from './agent/agentGraphService';
import { projectPendingInterrupt } from './conversation/pendingInterruptProjection';
import {
  runAgentSessionTurn,
  type AgentSessionTurnOptions,
  type AgentSessionTurnResult,
} from './agent/chatSessionAdapter';
import { loadAgentContext } from './contextLoader';
import { createLocalServerHandlers, type ServerHandlerOptions } from './serverHandlers';
import {
  dispatchLocalServerMessage,
  type LocalServerPeerHandlers,
} from './wire/messageDispatcher';
import { ServerTuiSessionService, type TuiSessionCheckpointer } from './session/serverTuiSessions';
import {
  createLocalServerRuntimeDepsStore,
  type ServerDeps,
  type ServerRuntimeDepsStore,
} from './serverTypes';
import type { HostExecutionConfig } from './config/hostExecutionConfig';
import type { HostToolkitInventoryStore } from './toolkits/toolkitInventory';
import type { LocalModelProfileRegistry } from './config/llmConfig';
import {
  configureInflightOperationRegistry,
  createInflightOperationRun,
  finishInflightOperations,
  overlayInflightDelegationOperations,
} from './inflightOperationRun';
import { emitLocalServerToolOperationEvent } from './serverOperationEvents';
import { createOperationRegistryForAgentSetup } from './runtimeOperationRegistry';

/**
 * The Host runtime: it builds one Pet's runtime and derives the two surfaces
 * that serve it.
 *
 * The port contracts live in host/contracts, and the admission gate shared by
 * conversation and dispatch lives in host/residentPetCoordinator. Both are
 * re-exported here: this module is the Host's entry point, and callers should
 * not have to know which file inside host/ declares what.
 */
export {
  ResidentPetInteractionBusyError,
  ResidentPetOperationCancelledError,
  type AgentSessionPeer,
  type PetDispatchLifecycleEvent,
  type PetDispatchLifecycleState,
  type PetDispatchPort,
  type PetDispatchQueueSnapshot,
  type PetDispatchRequest,
  type PetDispatchSettledState,
  type PetDispatchState,
  type ResidentPet,
  type ResidentPetCoordinatorOptions,
  type ResidentPetHost,
  type ResidentPetInteraction,
} from './host/contracts';
export { ResidentPetCoordinator } from './host/residentPetCoordinator';

import {
  ResidentPetInteractionBusyError,
  type AgentSessionPeer,
  type MaybePromise,
  type PetDispatchLifecycleEvent,
  type PetDispatchPort,
  type PetDispatchSettledState,
  type PetDispatchState,
  type ResidentPet,
  type ResidentPetHost,
  type ResidentPetInteraction,
} from './host/contracts';
import { ResidentPetCoordinator } from './host/residentPetCoordinator';

function defaultLogError(message: string, error: unknown): void {
  console.error(message, error instanceof Error ? error.message : error);
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
  /**
   * The one interactive client, or null. A Host serves one Pet whose session
   * state is single-valued, so interaction is exclusive; everything else
   * reaches the Pet through dispatch, which queues behind the availability
   * gate. Studio observes through the PetDispatchPort callbacks and never
   * attaches here.
   */
  interactivePeer: { current: AgentSessionPeer | null };
  publishRuntimeEvent: (event: AgentRuntimeEvent) => void;
  dispatchLifecycleListeners: Set<(event: PetDispatchLifecycleEvent) => void>;
  publishDispatchLifecycle: (event: PetDispatchLifecycleEvent) => void;
  activeHostRuns: Map<string, AbortController>;
  /** Shared with the local handlers: conversation and dispatch claim one register. */
  activeRuns: ActiveRunRegister;
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function admitConversationHandlers(
  handlers: LocalServerPeerHandlers,
  coordinator: ResidentPetCoordinator,
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
  return {
    // A conversation turn holds the gate like any other conversation work.
    // It claims the run register one layer down, in the local admission that
    // starts the run — the gate hold also covers the queue wait before it,
    // which is not yet a run.
    onChatRequest: admit(handlers.onChatRequest),
    onInterruptResume: admit(handlers.onInterruptResume),
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
  const interactivePeer: { current: AgentSessionPeer | null } = { current: null };
  const dispatchLifecycleListeners = new Set<(event: PetDispatchLifecycleEvent) => void>();
  const activeHostRuns = new Map<string, AbortController>();
  const activeRuns = new ActiveRunRegister();
  const publishRuntimeEvent = (event: AgentRuntimeEvent) => {
    const message = buildAgentEventEnvelope(event);
    const peer = interactivePeer.current;
    if (!peer || !peer.isConnected()) return;
    try {
      peer.send(message);
    } catch (error) {
      defaultLogError('[resident-pet] failed to publish Agent Session event:', error);
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
    activeRuns,
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
    petId: deps.petId,
  }) as ResidentPetRuntime;

  const close = () => {
    closing ??= (async () => {
      for (const controller of activeHostRuns.values()) controller.abort();
      const peer = interactivePeer.current;
      interactivePeer.current = null;
      if (peer) await peerHandlers.onClose(peer);
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
    interactivePeer,
    publishRuntimeEvent,
    dispatchLifecycleListeners,
    publishDispatchLifecycle,
    activeHostRuns,
    activeRuns,
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
    activeRuns,
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
          let activeRun: ActiveRun | null = null;
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
            activeRun = activeRuns.begin(requestId);
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
            if (activeRun) activeRuns.finish(activeRun);
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
  const { peerHandlers, interactivePeer } = context;
  const interaction: ResidentPetInteraction = {
    connect: (peer) => {
      if (context.isClosing()) throw new Error('Resident Pet interaction is closed.');
      // One interactive connection per Host. Everything else reaches a Pet
      // through dispatch, which is queued behind the availability gate — that
      // is what dispatch is for. Two interactive clients would instead race
      // over shared session state (the active session pointer is per-Pet), and
      // the runtime already assumes a single interaction elsewhere: the run
      // register is one value per Host and throws on a second claim.
      if (interactivePeer.current?.isConnected()) {
        throw new ResidentPetInteractionBusyError();
      }
      interactivePeer.current = peer;
    },
    handle: async (peer, message) => {
      if (context.isClosing() || interactivePeer.current !== peer) {
        throw new Error('Agent Session peer is not connected to this resident Pet.');
      }
      if (message.type === 'ping') {
        peer.send({ type: 'pong' });
        return;
      }
      await dispatchLocalServerMessage(peer, JSON.stringify(message), peerHandlers);
    },
    disconnect: async (peer) => {
      if (interactivePeer.current !== peer) return;
      interactivePeer.current = null;
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
