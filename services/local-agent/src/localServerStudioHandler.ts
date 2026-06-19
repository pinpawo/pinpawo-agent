import { WebSocket } from 'ws';
import {
  sendLocalAgentEvent,
  sendLocalAgentMessage,
  type HumanReviewResponseMessage,
  type StudioRequestMessage,
} from './localAgentProtocol';
import {
  type StreamToolsPayload,
} from './agentStreamEvents';
import {
  configureInflightOperationRegistry,
  type InflightOperationRun,
} from './inflightOperationRun';
import { InflightRequestController } from './inflightRequestController';
import { emitLocalServerToolOperationEvent } from './localServerOperationEvents';
import { StudioNotConfiguredError } from './studio/studioRuntime';
import { LocalServerStudioReviewRouter } from './localServerStudioReviews';
import type { LocalServerDeps } from './localServerTypes';
import { createOperationRegistryForLocalServerDeps } from './runtimeOperationRegistry';
import { StudioRunService, type BuildStudioForTurn } from './studioRunService';

type InflightRequest = InflightOperationRun;

export class LocalServerStudioHandler {
  private readonly reviewRouter: LocalServerStudioReviewRouter<WebSocket>;
  private readonly inflightRequests: InflightRequestController<WebSocket>;
  private readonly studioRunService: StudioRunService;

  constructor(options: {
    reviewRouter: LocalServerStudioReviewRouter<WebSocket>;
    inflightRequests: InflightRequestController<WebSocket>;
    studioRunService?: StudioRunService;
    buildStudio?: BuildStudioForTurn;
  }) {
    this.reviewRouter = options.reviewRouter;
    this.inflightRequests = options.inflightRequests;
    this.studioRunService = options.studioRunService ?? new StudioRunService({
      buildStudio: options.buildStudio,
    });
  }

  routeHumanReviewResponse(ws: WebSocket, msg: HumanReviewResponseMessage) {
    return this.reviewRouter.routeResponse(ws, msg);
  }

  rejectDisconnected(ws: WebSocket) {
    this.reviewRouter.rejectAndDelete(ws, new Error('ws disconnected'));
  }

  async handleStudioRequest(
    ws: WebSocket,
    msg: StudioRequestMessage,
    deps: LocalServerDeps,
  ) {
    const { requestId, userRequest } = msg;
    const conversationId = msg.conversationId ?? requestId;

    console.log(`[local-server] studio_request requestId=${requestId} userRequest="${userRequest.slice(0, 80)}"`);

    // 取消已有 inflight(避免跟 chat 重叠)
    const inflight = this.inflightRequests.start(ws, requestId, {
      interruptPrevious: true,
      notifyPrevious: true,
    });
    const { controller } = inflight;
    configureInflightOperationRegistry(
      inflight,
      createOperationRegistryForLocalServerDeps(deps),
    );

    // 重置 review slot(防止上一 turn 残留)
    const slot = this.reviewRouter.getOrCreateSlot(ws);
    if (slot.current) {
      this.reviewRouter.rejectPending(ws, new Error('superseded by new studio_request'));
    }

    const send = (envelope: unknown) => {
      if (!envelope || typeof envelope !== 'object') return;
      sendLocalAgentMessage(ws, envelope as Parameters<typeof sendLocalAgentMessage>[1]);
    };

    try {
      const result = await this.studioRunService.run({
        deps,
        runId: requestId,
        userRequest,
        conversationId,
        bridge: { send, requestId, slot },
        signal: controller.signal,
        onProgress: (event) => {
          sendLocalAgentEvent(ws, {
            type: 'studio.progress',
            requestId,
            event,
          });
        },
        onToolEvent: (event) => {
          this.sendStreamToolOperationEvent(ws, inflight, event as StreamToolsPayload);
        },
      });

      if (controller.signal.aborted) {
        this.inflightRequests.finish(ws, inflight, 'interrupted');
        send({ type: 'studio_error', requestId, message: 'aborted by client' });
        return;
      }

      this.inflightRequests.finish(ws, inflight, 'completed');
      if (result.turn.outcome.outcome === 'done') {
        send({
          type: 'studio_response',
          requestId,
          outcome: 'done',
          reply: result.turn.outcome.reply,
          finalDispatchId: result.turn.outcome.finalDispatchId,
          workdir: result.workdir,
          runId: result.runId,
          conversationId: result.conversationId,
          idempotencyKey: result.idempotencyKey,
        });
      } else {
        send({
          type: 'studio_response',
          requestId,
          outcome: 'stopped',
          reply: result.turn.outcome.reply,
          reason: result.turn.outcome.reason,
          workdir: result.workdir,
          runId: result.runId,
          conversationId: result.conversationId,
          idempotencyKey: result.idempotencyKey,
        });
      }
    } catch (err) {
      this.inflightRequests.finish(ws, inflight, 'failed', err);
      if (err instanceof StudioNotConfiguredError) {
        send({
          type: 'studio_error',
          requestId,
          message: `Studio 未配置:${err.message}`,
        });
      } else {
        console.error(
          '[local-server] handleStudioRequest error:',
          err instanceof Error ? err.message : err,
        );
        send({
          type: 'studio_error',
          requestId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      if (slot.current) {
        this.reviewRouter.rejectPending(ws, new Error('studio turn ended with unresolved review'));
      }
      this.inflightRequests.clear(ws, inflight);
    }
  }

  private sendStreamToolOperationEvent(
    ws: WebSocket,
    inflight: InflightRequest,
    payload: StreamToolsPayload,
  ) {
    emitLocalServerToolOperationEvent({
      run: inflight,
      payload,
      // Local studio review socket: include raw for diff/inspection rendering.
      emit: (event) => sendLocalAgentEvent(ws, event, { includeRaw: true }),
    });
  }
}
