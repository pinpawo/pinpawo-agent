import type { IncomingMessage, ServerResponse } from 'node:http';
import { FileStudioDueRunStore } from '@pinpawo/pet-agent';
import { LocalAgentGraphService } from './agentGraphService';
import { InflightRequestController } from './inflightRequestController';
import { buildLocalAgentSessionSnapshot } from './localAgentSessionSnapshot';
import type {
  LocalAgentSessionSummary,
} from './localAgentSession';
import type {
  LocalAgentSessionServerMessage,
} from './localAgentProtocol';
import { handleLocalHttpRequest } from './localHttpHandlers';
import { sendLocalServerPeerEvent, type LocalServerPeer } from './localServerPeer';
import type { LocalServerPeerHandlers } from './localServerMessageDispatcher';
import { LocalServerSessionCommandQueue } from './localServerSessionCommandQueue';
import { LocalServerChatHandler } from './localServerChatHandler';
import { LocalServerStudioHandler } from './localServerStudioHandler';
import { LocalServerStudioReviewRouter } from './localServerStudioReviews';
import { LocalServerTuiSessionService } from './localServerTuiSessions';
import { LocalStudioDueRunScheduler } from './localStudioDueRunScheduler';
import {
  createLocalServerRuntimeDepsStore,
  type LocalServerDeps,
} from './localServerTypes';

const INTERRUPT_FORCE_REPLY_MS = 1800;

export type LocalServerHandlers = {
  peerHandlers: LocalServerPeerHandlers;
  handleHttpRequest: (
    req: IncomingMessage,
    res: ServerResponse,
    authToken: string,
  ) => boolean;
  close: () => void;
};

type SessionSummarySource = Pick<
  LocalAgentSessionSummary,
  'id' | 'title' | 'messageCount' | 'createdAt' | 'updatedAt' | 'active'
>;

function projectChatSessionSummary(session: SessionSummarySource): LocalAgentSessionSummary {
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
export function createLocalServerHandlers(deps: LocalServerDeps): LocalServerHandlers {
  const runtimeDeps = createLocalServerRuntimeDepsStore(deps);
  const initialDeps = runtimeDeps.get();
  const effectiveRuntimeConfig = initialDeps.runtimeConfig;
  const chatGraphService = new LocalAgentGraphService();
  const tuiSessions = new LocalServerTuiSessionService({
    graphService: chatGraphService,
    runtimeConfig: effectiveRuntimeConfig,
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
    forceInterruptMs: INTERRUPT_FORCE_REPLY_MS,
    // Local TUI / companion / spawned stdio peer: trusted local transports.
    emitOperation: (peer, event) => sendLocalServerPeerEvent(peer, event, { includeRaw: true }),
    sendControl: (peer, message) => peer.send(message),
    logPrefix: 'local-server',
  });
  const chatHandler = new LocalServerChatHandler({
    graphService: chatGraphService,
    tuiSessions,
    inflightRequests,
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
  // Actor-wide admission: a session switch and chat operations never overlap.
  let activeChatOperations = 0;
  let sessionSwitch: Promise<void> | null = null;

  const loadSnapshot = async () => {
    const requestDeps = runtimeDeps.get();
    const checkpoint = await tuiSessions.readActiveCheckpointPoint(requestDeps);
    const pendingReview = chatHandler.buildReviewActionSnapshot(
      requestDeps,
      checkpoint.pendingReview,
    );
    return buildLocalAgentSessionSnapshot({
      sessionId: checkpoint.sessionId,
      kind: 'chat',
      messages: checkpoint.messages,
      deps: requestDeps,
      pendingReview,
    });
  };

  const listSessions = async () => {
    const sessions = await tuiSessions.listSessions(runtimeDeps.get());
    return sessions.map(projectChatSessionSummary);
  };

  const resumeSession = async (sessionId: string) => {
    while (sessionSwitch) {
      await sessionSwitch;
    }
    if (activeChatOperations > 0 || inflightRequests.hasActiveRequest()) {
      throw Object.assign(
        new Error('cannot resume a session while a run is active'),
        { code: 'session_resume_conflict' },
      );
    }

    let releaseSessionSwitch!: () => void;
    const currentSwitch = new Promise<void>((resolve) => {
      releaseSessionSwitch = resolve;
    });
    sessionSwitch = currentSwitch;
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
          pendingReview,
        }),
      };
    } finally {
      sessionSwitch = null;
      releaseSessionSwitch();
    }
  };

  const respondToSessionRequest = async (
    peer: LocalServerPeer,
    requestId: string,
    operation: 'snapshot' | 'list' | 'resume',
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
    admit: () => Promise<void>,
  ) => {
    await sessionCommands.waitForIdle(peer);
    while (sessionSwitch) {
      await sessionSwitch;
    }
    if (!peer.isConnected()) {
      return;
    }
    activeChatOperations += 1;
    try {
      await admit();
    } finally {
      activeChatOperations -= 1;
    }
  };

  const peerHandlers: LocalServerPeerHandlers = {
    onChatRequest: (client, message) => afterSessionCommands(
      client,
      () => chatHandler.handleChatRequest(
        client,
        message,
        runtimeDeps.get(),
      ),
    ),
    onStudioRequest: (client, message) => studioHandler.handleStudioRequest(
      client,
      message,
      runtimeDeps.get(),
    ),
    onHumanReviewResponse: async (client, message) => {
      if (studioHandler.routeHumanReviewResponse(client, message)) {
        return;
      }
      return afterSessionCommands(
        client,
        () => chatHandler.handleHumanReviewResponse(client, message, runtimeDeps.get()),
      );
    },
    onReviewCancel: (client, message) => afterSessionCommands(
      client,
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
    onRuntimeConfigUpdate: (_client, message) => {
      runtimeDeps.updateLlmConfig({
        globalReviewPolicyMode: message.globalReviewPolicyMode,
      });
      console.log(`[local-server] global review policy set to ${message.globalReviewPolicyMode}`);
    },
    onSessionSnapshotGet: (client, message) => sessionCommands.enqueue(
      client,
      () => respondToSessionRequest(
        client,
        message.requestId,
        'snapshot',
        async () => ({
          type: 'session.snapshot.result',
          requestId: message.requestId,
          snapshot: await loadSnapshot(),
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
    onClose: (client) => {
      sessionCommands.clear(client);
      inflightRequests.abortAndClear(client);
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
