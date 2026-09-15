import { ActiveRunRegister } from './agent/activeRunRegister';
import { LocalAgentGraphService } from './agent/agentGraphService';
import { runAgentSessionTurn } from './agent/chatSessionAdapter';
import { buildAgentEventEnvelope, type AgentRuntimeEvent } from '@pinpawo/agent-session';
import { createLocalServerHandlers } from './serverHandlers';
import type { LocalServerPeerHandlers } from './wire/messageDispatcher';
import {
  ServerTuiSessionService,
  type TuiSessionCheckpointer,
} from './session/serverTuiSessions';
import type { CapabilityArtifactStore } from '@pinpawo/pet-agent';
import {
  createLocalServerRuntimeDepsStore,
  type ServerDeps,
} from './serverTypes';
import type { LocalModelProfileRegistry } from './config/llmConfig';
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
  type AgentSessionPeer,
  type MaybePromise,
  type PetDispatchLifecycleEvent,
  type PetDispatchSettledState,
  type ResidentPetHost,
} from './host/contracts';
import { ResidentPetCoordinator } from './host/residentPetCoordinator';

function defaultLogError(message: string, error: unknown): void {
  console.error(message, error instanceof Error ? error.message : error);
}

export {
  type CreateResidentPetHostOptions,
  type CreateResidentPetRuntimeOptions,
  type ResidentPetRuntime,
} from './host/runtimeContext';
export { createResidentPet } from './host/residentPetDispatch';
export { createResidentPetInteraction } from './host/residentPetInteraction';

import {
  readResidentPetRuntimeContext,
  registerResidentPetRuntimeContext,
  type CreateResidentPetHostOptions,
  type CreateResidentPetRuntimeOptions,
  type ResidentPetRuntime,
  type ResidentPetRuntimeContext,
} from './host/runtimeContext';
import { createResidentPet } from './host/residentPetDispatch';
import { createResidentPetInteraction } from './host/residentPetInteraction';

function withDefaultModelProfile(
  registry: LocalModelProfileRegistry,
  modelProfileId: string | undefined,
): LocalModelProfileRegistry {
  if (!modelProfileId || modelProfileId === registry.defaultProfileId) return registry;
  registry.resolve(modelProfileId);
  return Object.freeze({ ...registry, defaultProfileId: modelProfileId });
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
  registerResidentPetRuntimeContext(runtime, context);
  await coordinator.refreshState();
  return runtime;
}

/** Derive the one-way dispatch surface from an existing resident runtime. */
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
