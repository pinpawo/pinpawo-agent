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
import type { InflightOperationRun } from './inflightOperationRun';
import { InflightRequestController } from './inflightRequestController';
import { emitLocalServerToolOperationEvent } from './localServerOperationEvents';
import {
  buildStudioForTurn,
  StudioNotConfiguredError,
  type BuildStudioInput,
  type BuildStudioResult,
} from './studio/studioRuntime';
import { LocalServerStudioReviewRouter } from './localServerStudioReviews';
import type { LocalServerDeps } from './localServerTypes';

type InflightRequest = InflightOperationRun;
type BuildStudioForTurn = (input: BuildStudioInput) => Promise<BuildStudioResult>;

export class LocalServerStudioHandler {
  private readonly reviewRouter: LocalServerStudioReviewRouter<WebSocket>;
  private readonly inflightRequests: InflightRequestController<WebSocket>;
  private readonly buildStudio: BuildStudioForTurn;

  constructor(options: {
    reviewRouter: LocalServerStudioReviewRouter<WebSocket>;
    inflightRequests: InflightRequestController<WebSocket>;
    buildStudio?: BuildStudioForTurn;
  }) {
    this.reviewRouter = options.reviewRouter;
    this.inflightRequests = options.inflightRequests;
    this.buildStudio = options.buildStudio ?? buildStudioForTurn;
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
      const { orchestrator } = await this.buildStudio({
        llmConfig: deps.llmConfig,
        capabilities: [
          ...(deps.localCapabilities ?? []),
          ...(deps.userCapabilities ?? []).map((u) => u.capability),
        ],
        tools: [...deps.pluginTools, ...deps.localTools],
        ownerUserId: null, // Phase 2 MVP: 纯本地,无服务端 owner 绑定
        bridge: { send, requestId, slot },
      });

      const result = await orchestrator.invoke({
        userRequest,
        conversationId,
        turnId: requestId,
        signal: controller.signal,
        onTurnEvent: (event) => {
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
      if (result.outcome.outcome === 'done') {
        send({
          type: 'studio_response',
          requestId,
          outcome: 'done',
          reply: result.outcome.reply,
          finalDispatchId: result.outcome.finalDispatchId,
        });
      } else {
        send({
          type: 'studio_response',
          requestId,
          outcome: 'stopped',
          reply: result.outcome.reply,
          reason: result.outcome.reason,
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
      emit: (event) => sendLocalAgentEvent(ws, event),
    });
  }
}
