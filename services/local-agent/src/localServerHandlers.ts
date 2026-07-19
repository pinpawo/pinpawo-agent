import type { IncomingMessage, ServerResponse } from 'node:http';
import { FileStudioDueRunStore } from '@pinpawo/pet-agent';
import { LocalAgentGraphService } from './agentGraphService';
import { InflightRequestController } from './inflightRequestController';
import { buildLocalAgentSessionSnapshot } from './localAgentSessionSnapshot';
import { handleLocalHttpRequest } from './localHttpHandlers';
import { sendLocalServerPeerEvent, type LocalServerPeer } from './localServerPeer';
import type { LocalServerPeerHandlers } from './localServerMessageDispatcher';
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

/**
 * Compose the shared local-agent handlers once, then attach any transport at
 * the outer boundary. HTTP remains available to the WebSocket server until
 * the snapshot/session command boundary is settled separately.
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

  const peerHandlers: LocalServerPeerHandlers = {
    onChatRequest: (client, message) => chatHandler.handleChatRequest(
      client,
      message,
      runtimeDeps.get(),
    ),
    onStudioRequest: (client, message) => studioHandler.handleStudioRequest(
      client,
      message,
      runtimeDeps.get(),
    ),
    onHumanReviewResponse: (client, message) => {
      if (studioHandler.routeHumanReviewResponse(client, message)) {
        return;
      }
      return chatHandler.handleHumanReviewResponse(client, message, runtimeDeps.get());
    },
    onReviewCancel: (client, message) => chatHandler.handleReviewCancel(
      client,
      message,
      runtimeDeps.get(),
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
    onClose: (client) => {
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
        loadSnapshot: async () => {
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
        },
        listSessions: () => tuiSessions.listSessions(requestDeps),
        resumeSession: async (sessionId) => {
          const result = await tuiSessions.resumeSession(requestDeps, sessionId);
          const pendingReview = chatHandler.buildReviewActionSnapshot(
            requestDeps,
            result.pendingReview,
          );
          return {
            session: {
              ...result.session,
              kind: 'chat',
            },
            snapshot: buildLocalAgentSessionSnapshot({
              sessionId: result.session.id,
              kind: 'chat',
              messages: result.messages,
              deps: requestDeps,
              pendingReview,
            }),
          };
        },
        updateCapabilities: (patch) => runtimeDeps.updateCapabilities(patch),
      });
    },
  };
}
