import { withoutPetInvocationContext } from './host/petInvocationContext';
import { continueSuspendedDispatch } from './host/dispatchContinuation';
import { ActiveRunRegister } from './agent/activeRunRegister';
import { HostGraphService } from './agent/agentGraphService';
import { runAgentSessionTurn } from './agent/chatSessionAdapter';
import {
  buildAgentEventEnvelope,
  type AgentRuntimeEvent,
  type AgentServerMessage,
} from '@pinpawo/agent-session';
import { createChatHostHandlers } from './serverHandlers';
import type { AgentSessionPeerHandlers } from './wire/messageDispatcher';
import {
  ServerTuiSessionService,
  type TuiSessionCheckpointer,
} from './session/serverTuiSessions';
import type { CapabilityArtifactStore } from '@pinpawo/pet-agent';
import {
  createChatHostDepsStore,
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
  PetSessionNotFoundError,
  PetSessionReviewRefusedError,
  ResidentPetInteractionBusyError,
  ResidentPetOperationCancelledError,
  type AgentSessionPeer,
  type PetDispatchLifecycleEvent,
  type PetDispatchLifecycleState,
  type PetDispatchMessage,
  type PetDispatchPort,
  type PetDispatchQueueSnapshot,
  type PetDispatchQueueEntry,
  type PetDispatchRequest,
  type PetDispatchSettledState,
  type PetDispatchState,
  type PetSessionPort,
  type PetSessionReviewRequest,
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
export { createResidentPetSessions } from './host/residentPetSessions';

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
import { createResidentPetSessions } from './host/residentPetSessions';

function withDefaultModelProfile(
  registry: LocalModelProfileRegistry,
  modelProfileId: string | undefined,
): LocalModelProfileRegistry {
  if (!modelProfileId || modelProfileId === registry.defaultProfileId) return registry;
  registry.resolve(modelProfileId);
  return Object.freeze({ ...registry, defaultProfileId: modelProfileId });
}

function admitConversationHandlers(
  handlers: AgentSessionPeerHandlers,
  coordinator: ResidentPetCoordinator,
): AgentSessionPeerHandlers {
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
    capabilityCatalog: {
      getSnapshot: () => ({ capabilities: options.capabilities }),
    },
    ...(options.defaultCapabilityName
      ? { defaultCapabilityName: options.defaultCapabilityName }
      : {}),
    ...(options.petDocument ? { petDocument: options.petDocument } : {}),
    capabilityArtifactStore: options.capabilityArtifactStore,
  };
  const runtimeDeps = createChatHostDepsStore(deps);
  const graphService = options.graphService ?? new HostGraphService();
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
    // Only a pending native review holds dispatch. Retained plans alone
    // do not block new input or require recovery.
    if (state.pendingInterrupt) return 'waiting';
    return 'open';
  };
  const coordinator = new ResidentPetCoordinator({ readSettledState });
  const interactivePeer: { current: AgentSessionPeer | null } = { current: null };
  const dispatchLifecycleListeners = new Set<(event: PetDispatchLifecycleEvent) => void>();
  const activeRuns = new ActiveRunRegister();
  const messageListeners = new Set<(message: AgentServerMessage) => void>();
  const sessionListeners = new Map<string, Set<(message: AgentServerMessage) => void>>();
  const sessionPeers = new WeakMap<AgentSessionPeer, string>();
  const openSessionPeers = new Set<AgentSessionPeer>();
  const notify = (
    listeners: Iterable<(message: AgentServerMessage) => void>,
    message: AgentServerMessage,
  ) => {
    for (const listener of listeners) {
      try { listener(message); } catch (error) {
        defaultLogError('[resident-pet] event observer failed:', error);
      }
    }
  };
  const publishMessage = (message: AgentServerMessage) => {
    notify(messageListeners, message);
    const peer = interactivePeer.current;
    if (!peer || !peer.isConnected()) return;
    try {
      peer.send(message);
    } catch (error) {
      defaultLogError('[resident-pet] failed to publish Agent Session event:', error);
    }
  };
  const publishSessionMessage = (sessionId: string, message: AgentServerMessage) => {
    const observers = sessionListeners.get(sessionId);
    if (observers) notify([...observers], message);
    // The Pet-level stream and the interactive client follow the active session.
    if (sessions.peekActiveSessionId(deps.petId) === sessionId) publishMessage(message);
  };
  const publishSessionEvent = (sessionId: string, event: AgentRuntimeEvent) => {
    publishSessionMessage(sessionId, buildAgentEventEnvelope(event));
  };
  const publishRuntimeEvent = (event: AgentRuntimeEvent) => {
    const activeId = sessions.peekActiveSessionId(deps.petId);
    if (activeId) publishSessionEvent(activeId, event);
    else publishMessage(buildAgentEventEnvelope(event));
  };
  const observeSession = (sessionId: string, listener: (message: AgentServerMessage) => void) => {
    let observers = sessionListeners.get(sessionId);
    if (!observers) sessionListeners.set(sessionId, observers = new Set());
    const entry = (message: AgentServerMessage) => listener(message);
    observers.add(entry);
    return () => {
      observers.delete(entry);
      if (!observers.size && sessionListeners.get(sessionId) === observers) sessionListeners.delete(sessionId);
    };
  };
  const openSessionPeer = (sessionId: string) => {
    const peer: AgentSessionPeer = {
      isConnected: () => closing === null,
      send: (message) => { publishSessionMessage(sessionId, message); return closing === null; },
    };
    sessionPeers.set(peer, sessionId);
    openSessionPeers.add(peer);
    return { peer, release: () => { openSessionPeers.delete(peer); } };
  };
  const hostPeer: AgentSessionPeer = {
    isConnected: () => closing === null,
    send: (message) => { publishMessage(message); return closing === null; },
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
  const runConversationTurn = continueSuspendedDispatch({
    petId: deps.petId, sessions, publishLifecycle: publishDispatchLifecycle, run: runAgentTurn,
  });
  const localHandlers: ReturnType<typeof createChatHostHandlers> = createChatHostHandlers(runtimeDeps, {
    persistGlobalReviewPolicyMode: options.persistGlobalReviewPolicyMode,
    chatGraphService: graphService,
    tuiSessions: sessions,
    loadContext,
    runAgentTurn: (input) => withoutPetInvocationContext(() => runConversationTurn(input)),
    // A session-bound origin publishes to its session; any other origin is a
    // turn of the active session.
    publishRuntimeEvent: (origin, event) => {
      const sessionId = sessionPeers.get(origin);
      if (sessionId) publishSessionEvent(sessionId, event);
      else publishRuntimeEvent(event);
    },
    activeRuns,
    // A dispatch or a Host-owned request runs on a peer other than the one
    // asking to stop it.
    interruptHostRun: (requestId) => localHandlers.interruptRun(requestId),
  });
  const peerHandlers = admitConversationHandlers(localHandlers.peerHandlers, coordinator);
  let closing: Promise<void> | null = null;

  const runtime = Object.freeze({
    petId: deps.petId,
  }) as ResidentPetRuntime;

  const close = () => {
    closing ??= (async () => {
      const peer = interactivePeer.current;
      interactivePeer.current = null;
      if (peer) await peerHandlers.onClose(peer);
      await peerHandlers.onClose(hostPeer);
      for (const sessionPeer of openSessionPeers) await peerHandlers.onClose(sessionPeer);
      openSessionPeers.clear();
      await coordinator.close();
      messageListeners.clear();
      sessionListeners.clear();
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
    hostPeer,
    messageListeners,
    publishRuntimeEvent,
    publishSessionMessage,
    publishSessionEvent,
    observeSession,
    openSessionPeer,
    dispatchLifecycleListeners,
    publishDispatchLifecycle,
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
  const sessions = createResidentPetSessions(runtime);
  const { close } = readResidentPetRuntimeContext(runtime);
  return {
    resident,
    interaction,
    sessions,
    close,
  };
}
