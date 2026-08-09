import type { IncomingMessage, ServerResponse } from 'node:http';
import { FileStudioDueRunStore } from '@pinpawo-toolkit/studio-kanban';
import { DEFAULT_TOOL_AUTHORIZATION_SAFETY_LEVEL } from '@pinpawo/agent-contracts';
import { compactOrchestratorMessages } from '@pinpawo/pet-agent';
import type { AgentLlmConfig } from './agentConfig';
import { LocalAgentGraphService } from './agentGraphService';
import { InflightRequestController } from './inflightRequestController';
import { buildLocalAgentSessionSnapshot } from './localAgentSessionSnapshot';
import type {
  AgentModelProfileSummary,
  AgentRunView,
  AgentSessionSummary,
} from '@pinpawo/agent-session';
import type {
  LocalAgentSessionServerMessage,
} from './localAgentProtocol';
import { handleLocalHttpRequest } from './localHttpHandlers';
import { sendLocalServerPeerEvent, type LocalServerPeer } from './localServerPeer';
import type { LocalServerPeerHandlers } from './localServerMessageDispatcher';
import { LocalServerSessionCommandQueue } from './localServerSessionCommandQueue';
import { LocalServerChatHandler } from './localServerChatHandler';
import type {
  ChatSessionAdapterOptions,
  ChatSessionResult,
} from './chatSessionAdapter';
import { LocalServerStudioHandler } from './localServerStudioHandler';
import { LocalServerStudioReviewRouter } from './localServerStudioReviews';
import { LocalServerTuiSessionService } from './localServerTuiSessions';
import { LocalStudioDueRunScheduler } from './localStudioDueRunScheduler';
import { persistGlobalReviewPolicyMode } from './globalReviewPolicyConfig';
import { loadAgentContext } from './contextLoader';
import {
  missingInputModalities,
  supportsInputModalities,
} from './modelProfiles';
import {
  createLocalServerRuntimeDepsStore,
  type LocalServerDeps,
} from './localServerTypes';

export type LocalServerHandlers = {
  peerHandlers: LocalServerPeerHandlers;
  handleHttpRequest: (
    req: IncomingMessage,
    res: ServerResponse,
    authToken: string,
  ) => boolean;
  close: () => void;
};

export type LocalServerHandlerOptions = {
  persistGlobalReviewPolicyMode?: typeof persistGlobalReviewPolicyMode;
  /** Composition hook for embedded hosts and deterministic integration tests. */
  chatGraphService?: LocalAgentGraphService;
  /** Must be shared by chat execution and checkpoint-backed session reads. */
  loadContext?: typeof loadAgentContext;
  /** Deterministic run-boundary hook for embedded hosts and tests. */
  runChat?: (
    options: ChatSessionAdapterOptions,
  ) => Promise<ChatSessionResult>;
};

type SessionSummarySource = Pick<
  AgentSessionSummary,
  'id' | 'title' | 'messageCount' | 'createdAt' | 'updatedAt' | 'active'
>;

type ActiveChatRun = {
  requestId: string;
  startedAt: number;
};

function projectChatSessionSummary(session: SessionSummarySource): AgentSessionSummary {
  return {
    id: session.id,
    kind: 'chat',
    title: session.title,
    messageCount: session.messageCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    active: session.active,
  };
}

/**
 * Compose the shared local-agent handlers once, then attach any transport at
 * the outer boundary. HTTP endpoints and stdio session commands call the same
 * checkpoint-backed operations below.
 */
export function createLocalServerHandlers(
  deps: LocalServerDeps,
  options: LocalServerHandlerOptions = {},
): LocalServerHandlers {
  const runtimeDeps = createLocalServerRuntimeDepsStore(deps);
  const initialDeps = runtimeDeps.get();
  const effectiveRuntimeConfig = initialDeps.runtimeConfig;
  const chatGraphService = options.chatGraphService ?? new LocalAgentGraphService();
  const tuiSessions = new LocalServerTuiSessionService({
    graphService: chatGraphService,
    ...(options.loadContext ? { loadContext: options.loadContext } : {}),
    runtimeConfig: effectiveRuntimeConfig,
    defaultModelProfileId: initialDeps.modelProfiles.defaultProfileId,
  });
  const studioReviewRouter = new LocalServerStudioReviewRouter<LocalServerPeer>();
  const ownsStudioDueRunScheduler = !initialDeps.studioDueRunScheduler;
  const studioDueRunScheduler = initialDeps.studioDueRunScheduler
    ?? new LocalStudioDueRunScheduler({
      store: new FileStudioDueRunStore({
        filePath: effectiveRuntimeConfig.studioDueRunsPath,
      }),
      filterWorkdir: effectiveRuntimeConfig.workdir,
    });
  const inflightRequests = new InflightRequestController<LocalServerPeer>({
    // Local TUI / companion / spawned stdio peer: trusted local transports.
    emitOperation: (peer, event) => sendLocalServerPeerEvent(peer, event),
    sendControl: (peer, message) => peer.send(message),
  });
  const chatHandler = new LocalServerChatHandler({
    graphService: chatGraphService,
    tuiSessions,
    inflightRequests,
    ...(options.loadContext ? { loadContext: options.loadContext } : {}),
    ...(options.runChat ? { runChat: options.runChat } : {}),
  });
  const studioHandler = new LocalServerStudioHandler({
    reviewRouter: studioReviewRouter,
    inflightRequests,
    outbound: {
      sendMessage: (peer, message) => peer.send(message),
      sendEvent: (peer, event) => sendLocalServerPeerEvent(peer, event),
    },
    studioDueRunScheduler,
  });
  const sessionCommands = new LocalServerSessionCommandQueue();
  // Actor-wide admission: session transitions and chat operations never overlap.
  let activeChatOperations = 0;
  let sessionTransition: Promise<void> | null = null;
  const activeChatRuns = new WeakMap<LocalServerPeer, ActiveChatRun>();

  const loadSnapshot = async (peer?: LocalServerPeer) => {
    const requestDeps = runtimeDeps.get();
    const checkpoint = await tuiSessions.readActiveCheckpointPoint(requestDeps);
    const pendingReview = chatHandler.buildReviewActionSnapshot(
      requestDeps,
      checkpoint.pendingReview,
    );
    const active = peer ? activeChatRuns.get(peer) : null;
    const inflight = peer ? inflightRequests.get(peer) : null;
    const activeRun: Extract<AgentRunView, { state: 'running' }> | null = active
      && inflight?.requestId === active.requestId
      ? {
        requestId: active.requestId,
        state: 'running',
        activity: 'thinking',
        startedAt: active.startedAt,
      }
      : null;
    return buildLocalAgentSessionSnapshot({
      sessionId: checkpoint.sessionId,
      kind: 'chat',
      messages: checkpoint.messages,
      deps: requestDeps,
      modelProfileId: checkpoint.modelProfileId,
      requiredInputModalities: checkpoint.requiredInputModalities,
      sessionTokenUsage: checkpoint.sessionTokenUsage,
      pendingReview,
      activeRun,
      currentPlan: checkpoint.currentPlan,
    });
  };

  const listSessions = async () => {
    const sessions = await tuiSessions.listSessions(runtimeDeps.get());
    return sessions.map(projectChatSessionSummary);
  };

  const listModelProfiles = async (sessionId: string) => {
    const requestDeps = runtimeDeps.get();
    const activeSession = tuiSessions.getActiveSession(requestDeps.actorId);
    if (!tuiSessions.getSession(requestDeps.actorId, sessionId)) {
      throw Object.assign(
        new Error('session not found'),
        { code: 'session_not_found' },
      );
    }
    if (activeSession.id !== sessionId) {
      throw Object.assign(
        new Error('model listing requires the active session'),
        { code: 'session_not_active' },
      );
    }
    // Read the modalities off the transcript rather than a stored counter, so a
    // session that was rolled back or repaired reports what it actually holds.
    const { requiredInputModalities } = await tuiSessions.readSessionCheckpointPoint(
      requestDeps,
      activeSession,
    );
    const profiles: AgentModelProfileSummary[] = [
      ...requestDeps.modelProfiles.listAvailable().map((profile) => {
        const compatible = supportsInputModalities(
          requiredInputModalities,
          profile.inputModalities,
        );
        return {
          ...profile,
          inputModalities: [...profile.inputModalities],
          available: true,
          compatible,
          issues: compatible
            ? []
            : [
                `Session requires ${requiredInputModalities.join(', ')} input; model is missing ${
                  missingInputModalities(
                    requiredInputModalities,
                    profile.inputModalities,
                  ).join(', ')
                }`,
              ],
        };
      }),
      ...Object.entries(
        requestDeps.modelProfiles.snapshot.unavailableProfiles,
      ).map(([id, issues]) => ({
        id,
        label: id,
        inputModalities: ['text' as const],
        available: false,
        compatible: false,
        issues: issues.map((issue) => issue.message),
      })),
    ];
    if (!profiles.some((profile) => profile.id === activeSession.modelProfileId)) {
      profiles.push({
        id: activeSession.modelProfileId,
        label: activeSession.modelProfileId,
        inputModalities: ['text'],
        available: false,
        compatible: false,
        issues: [
          `Selected model profile "${activeSession.modelProfileId}" is no longer configured`,
        ],
      });
    }
    return {
      sessionId,
      defaultProfileId: requestDeps.modelProfiles.defaultProfileId,
      selectedProfileId: activeSession.modelProfileId,
      requiredInputModalities: [...requiredInputModalities],
      profiles,
    };
  };

  const sendModelSelectionError = (
    peer: LocalServerPeer,
    message: {
      requestId: string;
      sessionId: string;
      modelProfileId?: string;
    },
    code:
      | 'session_not_found'
      | 'session_not_active'
      | 'run_active'
      | 'review_pending'
      | 'profile_unavailable'
      | 'profile_incompatible'
      | 'selection_failed',
    detail: string,
  ) => {
    peer.send({
      type: 'model.select.error',
      requestId: message.requestId,
      sessionId: message.sessionId,
      ...(message.modelProfileId
        ? { modelProfileId: message.modelProfileId }
        : {}),
      code,
      message: detail,
    });
  };

  const selectModelProfile = async (
    peer: LocalServerPeer,
    message: {
      requestId: string;
      sessionId: string;
      modelProfileId: string;
    },
  ) => {
    while (sessionTransition) {
      await sessionTransition;
    }
    if (activeChatOperations > 0) {
      sendModelSelectionError(
        peer,
        message,
        'run_active',
        'cannot switch models while a session run is active',
      );
      return;
    }
    let releaseSessionTransition!: () => void;
    const currentTransition = new Promise<void>((resolve) => {
      releaseSessionTransition = resolve;
    });
    sessionTransition = currentTransition;
    let selectionCommitted = false;
    try {
      const requestDeps = runtimeDeps.get();
      const activeSession = tuiSessions.getActiveSession(requestDeps.actorId);
      if (!tuiSessions.getSession(requestDeps.actorId, message.sessionId)) {
        sendModelSelectionError(
          peer,
          message,
          'session_not_found',
          'session not found',
        );
        return;
      }
      if (activeSession.id !== message.sessionId) {
        sendModelSelectionError(
          peer,
          message,
          'session_not_active',
          'model selection requires the active session',
        );
        return;
      }
      let selectedProfile: Readonly<AgentLlmConfig>;
      try {
        selectedProfile = requestDeps.modelProfiles.resolve(message.modelProfileId);
      } catch (error) {
        sendModelSelectionError(
          peer,
          message,
          'profile_unavailable',
          error instanceof Error ? error.message : 'model profile is unavailable',
        );
        return;
      }
      const candidateSession = {
        ...activeSession,
        modelProfileId: message.modelProfileId,
      };
      const checkpoint = await tuiSessions.readSessionCheckpointPoint(
        requestDeps,
        candidateSession,
      );
      // The transcript is the authority on which modalities the session holds,
      // so a profile is rejected only when the history really needs more than
      // it accepts.
      if (!supportsInputModalities(
        checkpoint.requiredInputModalities,
        selectedProfile.inputModalities ?? ['text'],
      )) {
        sendModelSelectionError(
          peer,
          message,
          'profile_incompatible',
          `Session requires ${checkpoint.requiredInputModalities.join(', ')} input; model is missing ${
            missingInputModalities(
              checkpoint.requiredInputModalities,
              selectedProfile.inputModalities ?? ['text'],
            ).join(', ')
          }`,
        );
        return;
      }
      if (checkpoint.pendingReview) {
        sendModelSelectionError(
          peer,
          message,
          'review_pending',
          'cannot switch models while human review is pending',
        );
        return;
      }
      const snapshot = buildLocalAgentSessionSnapshot({
        sessionId: candidateSession.id,
        kind: 'chat',
        messages: checkpoint.messages,
        deps: requestDeps,
        modelProfileId: candidateSession.modelProfileId,
        requiredInputModalities: checkpoint.requiredInputModalities,
        sessionTokenUsage: checkpoint.sessionTokenUsage,
        pendingReview: null,
        currentPlan: checkpoint.currentPlan,
      });
      const session = tuiSessions.selectModelProfile(
        requestDeps.actorId,
        message.sessionId,
        message.modelProfileId,
      );
      selectionCommitted = true;
      peer.send({
        type: 'model.select.result',
        requestId: message.requestId,
        sessionId: session.id,
        selectedProfileId: session.modelProfileId,
        snapshot,
      });
    } catch (error) {
      if (selectionCommitted) {
        console.warn(
          '[local-server] model selection was committed but acknowledgement failed:',
          error instanceof Error ? error.message : error,
        );
        return;
      }
      sendModelSelectionError(
        peer,
        message,
        'selection_failed',
        error instanceof Error ? error.message : 'model selection failed',
      );
    } finally {
      if (sessionTransition === currentTransition) {
        sessionTransition = null;
      }
      releaseSessionTransition();
    }
  };

  const createSession = async () => {
    while (sessionTransition) {
      await sessionTransition;
    }
    if (activeChatOperations > 0 || inflightRequests.hasActiveRequest()) {
      throw Object.assign(
        new Error('cannot create a session while a run is active'),
        { code: 'session_new_conflict' },
      );
    }

    let releaseSessionTransition!: () => void;
    const currentTransition = new Promise<void>((resolve) => {
      releaseSessionTransition = resolve;
    });
    sessionTransition = currentTransition;
    try {
      const requestDeps = runtimeDeps.get();
      const session = tuiSessions.createNewSession(requestDeps.actorId);
      return {
        session: projectChatSessionSummary({
          ...session,
          active: true,
        }),
        snapshot: buildLocalAgentSessionSnapshot({
          sessionId: session.id,
          kind: 'chat',
          messages: [],
          deps: requestDeps,
          modelProfileId: session.modelProfileId,
          requiredInputModalities: session.requiredInputModalities,
          sessionTokenUsage: null,
          pendingReview: null,
          currentPlan: null,
        }),
      };
    } finally {
      sessionTransition = null;
      releaseSessionTransition();
    }
  };

  const resumeSession = async (sessionId: string) => {
    while (sessionTransition) {
      await sessionTransition;
    }
    // Disconnect aborts active runs but deliberately leaves ownership with
    // their invocation owners until graph output settles. Keep that brief
    // settlement window in this actor-wide admission check so a session switch
    // cannot race the old thread's final checkpoint write.
    if (activeChatOperations > 0 || inflightRequests.hasActiveRequest()) {
      throw Object.assign(
        new Error('cannot resume a session while a run is active'),
        { code: 'session_resume_conflict' },
      );
    }

    let releaseSessionTransition!: () => void;
    const currentTransition = new Promise<void>((resolve) => {
      releaseSessionTransition = resolve;
    });
    sessionTransition = currentTransition;
    try {
      const requestDeps = runtimeDeps.get();
      const result = await tuiSessions.resumeSession(requestDeps, sessionId);
      const pendingReview = chatHandler.buildReviewActionSnapshot(
        requestDeps,
        result.pendingReview,
      );
      return {
        session: projectChatSessionSummary(result.session),
        snapshot: buildLocalAgentSessionSnapshot({
          sessionId: result.session.id,
          kind: 'chat',
          messages: result.messages,
          deps: requestDeps,
          modelProfileId: result.session.modelProfileId,
          requiredInputModalities: result.session.requiredInputModalities,
          sessionTokenUsage: result.sessionTokenUsage,
          pendingReview,
          currentPlan: result.currentPlan,
        }),
      };
    } finally {
      sessionTransition = null;
      releaseSessionTransition();
    }
  };

  const compactSession = async (sessionId: string) => {
    while (sessionTransition) {
      await sessionTransition;
    }
    if (activeChatOperations > 0 || inflightRequests.hasActiveRequest()) {
      throw new Error('cannot compact context while a session run is active');
    }

    let releaseSessionTransition!: () => void;
    const currentTransition = new Promise<void>((resolve) => {
      releaseSessionTransition = resolve;
    });
    sessionTransition = currentTransition;
    try {
      const requestDeps = runtimeDeps.get();
      const session = tuiSessions.getSession(requestDeps.actorId, sessionId);
      if (!session) {
        throw new Error('session not found');
      }
      const activeSession = tuiSessions.getActiveSession(requestDeps.actorId);
      if (activeSession.id !== session.id) {
        throw new Error('context compaction requires the active session');
      }
      const ctx = await (options.loadContext ?? loadAgentContext)(requestDeps.actorId);
      const setup = tuiSessions.buildChatSetup(requestDeps, ctx, session.threadId);
      const state = await chatGraphService.readThreadState(setup);
      if (state.pendingHumanReview) {
        throw new Error('cannot compact context while human review is pending');
      }
      const result = await compactOrchestratorMessages({
        messages: state.messages,
        model: setup.graphConfig.models.observe ?? setup.graphConfig.models.act,
      });
      if (result.compacted) {
        await chatGraphService.updateState(setup, { messages: result.messages });
        await tuiSessions.refreshActiveSessionSummary(requestDeps);
      }
      return {
        compacted: result.compacted,
        snapshot: await loadSnapshot(),
      };
    } finally {
      if (sessionTransition === currentTransition) {
        sessionTransition = null;
      }
      releaseSessionTransition();
    }
  };

  const respondToSessionRequest = async (
    peer: LocalServerPeer,
    requestId: string,
    operation: 'snapshot' | 'list' | 'new' | 'resume' | 'compact',
    load: () => Promise<LocalAgentSessionServerMessage>,
  ) => {
    try {
      peer.send(await load());
    } catch (error) {
      peer.send({
        type: 'session.error',
        requestId,
        operation,
        message: error instanceof Error ? error.message : `${operation} failed`,
      });
    }
  };

  const afterSessionCommands = async (
    peer: LocalServerPeer,
    requestId: string,
    admit: () => Promise<void>,
  ) => {
    await sessionCommands.waitForIdle(peer);
    while (sessionTransition) {
      await sessionTransition;
    }
    if (!peer.isConnected()) {
      return;
    }
    const activeRun: ActiveChatRun = {
      requestId,
      startedAt: Date.now(),
    };
    activeChatRuns.set(peer, activeRun);
    activeChatOperations += 1;
    try {
      await admit();
    } finally {
      activeChatOperations -= 1;
      if (activeChatRuns.get(peer) === activeRun) {
        activeChatRuns.delete(peer);
      }
    }
  };

  /**
   * #561:一个 server 进程只有一个主模式。mode 不只是启动预检与投影,
   * 它是**执行边界** —— 与当前模式不符的请求直接拒绝,而不是照常执行。
   *
   * 拒绝而非静默忽略:客户端连错模式时应该立刻知道,否则会一直等一个
   * 永远不来的回包。
   */
  function rejectWrongMode(
    client: LocalServerPeer,
    requestId: string,
    kind: 'chat' | 'studio',
  ): void {
    const mode = runtimeDeps.get().serverMode;
    const message = `This server runs in ${mode} mode; ${kind} requests are not accepted.`;
    if (kind === 'studio') {
      client.send({ type: 'studio_error', requestId, message });
      return;
    }
    // 不设 code:AgentErrorCode 是 #570 拥有的共享契约,为一个本地
    // 模式检查去扩它不划算;message 已经自解释。
    sendLocalServerPeerEvent(client, { type: 'error', requestId, message });
  }

  const peerHandlers: LocalServerPeerHandlers = {
    onChatRequest: (client, message) => {
      if (runtimeDeps.get().serverMode !== 'chat') {
        rejectWrongMode(client, message.requestId, 'chat');
        return Promise.resolve();
      }
      return afterSessionCommands(
        client,
        message.requestId,
        () => chatHandler.handleChatRequest(
          client,
          message,
          runtimeDeps.get(),
        ),
      );
    },
    onStudioRequest: (client, message) => {
      if (runtimeDeps.get().serverMode !== 'studio') {
        rejectWrongMode(client, message.requestId, 'studio');
        return Promise.resolve();
      }
      return studioHandler.handleStudioRequest(
        client,
        message,
        runtimeDeps.get(),
      );
    },
    onHumanReviewResponse: async (client, message) => {
      if (studioHandler.routeHumanReviewResponse(client, message)) {
        return;
      }
      return afterSessionCommands(
        client,
        message.requestId,
        () => chatHandler.handleHumanReviewResponse(client, message, runtimeDeps.get()),
      );
    },
    onReviewCancel: (client, message) => afterSessionCommands(
      client,
      message.requestId,
      () => chatHandler.handleReviewCancel(
        client,
        message,
        runtimeDeps.get(),
      ),
    ),
    onRunInterrupt: (client, message) => {
      const inflight = chatHandler.handleRunInterrupt(client, message);
      if (inflight) {
        console.log(`[local-server] interrupt requestId=${inflight.requestId}`);
      }
    },
    onNewSession: () => {
      const actorId = runtimeDeps.get().actorId;
      tuiSessions.createNewSession(actorId);
      console.log(`[local-server] new session created for pet ${actorId}`);
    },
    onRuntimeConfigUpdate: (client, message) => sessionCommands.enqueue(
      client,
      async () => {
        try {
          const autoAuthorizationSafetyLevel = message.autoAuthorizationSafetyLevel
            ?? runtimeDeps.get().autoAuthorizationSafetyLevel
            ?? DEFAULT_TOOL_AUTHORIZATION_SAFETY_LEVEL;
          (options.persistGlobalReviewPolicyMode ?? persistGlobalReviewPolicyMode)(
            message.globalReviewPolicyMode,
            autoAuthorizationSafetyLevel,
          );
          runtimeDeps.updateGlobalReviewPolicyMode(message.globalReviewPolicyMode);
          runtimeDeps.updateAutoAuthorizationSafetyLevel(autoAuthorizationSafetyLevel);
          if (message.requestId) {
            client.send({
              type: 'runtime_config.result',
              requestId: message.requestId,
              globalReviewPolicyMode: message.globalReviewPolicyMode,
              autoAuthorizationSafetyLevel,
            });
          }
          console.log(
            `[local-server] global review policy set to ${message.globalReviewPolicyMode}`
              + ` (${autoAuthorizationSafetyLevel})`,
          );
        } catch (error) {
          if (!message.requestId) throw error;
          client.send({
            type: 'runtime_config.error',
            requestId: message.requestId,
            message: error instanceof Error
              ? error.message
              : 'global review policy could not be saved',
          });
        }
      },
    ),
    onSessionSnapshotGet: (client, message) => sessionCommands.enqueue(
      client,
      () => respondToSessionRequest(
        client,
        message.requestId,
        'snapshot',
        async () => ({
          type: 'session.snapshot.result',
          requestId: message.requestId,
          snapshot: await loadSnapshot(client),
        }),
      ),
    ),
    onSessionList: (client, message) => sessionCommands.enqueue(
      client,
      () => respondToSessionRequest(
        client,
        message.requestId,
        'list',
        async () => ({
          type: 'session.list.result',
          requestId: message.requestId,
          sessions: await listSessions(),
        }),
      ),
    ),
    onSessionNew: (client, message) => sessionCommands.enqueue(
      client,
      () => respondToSessionRequest(
        client,
        message.requestId,
        'new',
        async () => ({
          type: 'session.new.result',
          requestId: message.requestId,
          ...await createSession(),
        }),
      ),
    ),
    onSessionResume: (client, message) => sessionCommands.enqueue(
      client,
      () => respondToSessionRequest(
        client,
        message.requestId,
        'resume',
        async () => {
          return {
            type: 'session.resume.result',
            requestId: message.requestId,
            ...await resumeSession(message.sessionId),
          };
        },
      ),
    ),
    onSessionCompact: (client, message) => sessionCommands.enqueue(
      client,
      () => respondToSessionRequest(
        client,
        message.requestId,
        'compact',
        async () => ({
          type: 'session.compact.result',
          requestId: message.requestId,
          ...await compactSession(message.sessionId),
        }),
      ),
    ),
    onModelList: (client, message) => sessionCommands.enqueue(
      client,
      async () => {
        try {
          client.send({
            type: 'model.list.result',
            requestId: message.requestId,
            ...(await listModelProfiles(message.sessionId)),
          });
        } catch (error) {
          sendModelSelectionError(
            client,
            message,
            (error as { code?: string }).code === 'session_not_active'
              ? 'session_not_active'
              : 'session_not_found',
            error instanceof Error ? error.message : 'session not found',
          );
        }
      },
    ),
    onModelSelect: (client, message) => sessionCommands.enqueue(
      client,
      () => selectModelProfile(client, message),
    ),
    onClose: (client) => {
      sessionCommands.clear(client);
      activeChatRuns.delete(client);
      inflightRequests.abortAll(client);
      studioHandler.rejectDisconnected(client);
    },
  };

  return {
    peerHandlers,
    close: () => {
      if (ownsStudioDueRunScheduler) {
        studioDueRunScheduler.stop();
      }
    },
    handleHttpRequest: (req, res, authToken) => {
      const requestDeps = runtimeDeps.get();
      return handleLocalHttpRequest(req, res, requestDeps, {
        authToken,
        loadSnapshot,
        listSessions,
        resumeSession,
        updateCapabilities: (patch) => runtimeDeps.updateCapabilities(patch),
      });
    },
  };
}
