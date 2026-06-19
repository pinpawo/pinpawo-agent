import { WebSocket } from 'ws';
import {
  sendLocalAgentEvent,
  sendLocalAgentMessage,
  type HumanReviewResponseMessage,
  type StudioRequestMessage,
} from './localAgentProtocol';
import type { StreamToolsPayload } from './agentStreamEvents';
import {
  configureInflightOperationRegistry,
  type InflightOperationRun,
} from './inflightOperationRun';
import { InflightRequestController } from './inflightRequestController';
import { emitLocalServerToolOperationEvent } from './localServerOperationEvents';
import {
  LocalStudioDueRunCompletion,
  LocalStudioDueRunScheduler,
} from './localStudioDueRunScheduler';
import { StudioNotConfiguredError } from './studio/studioRuntime';
import { LocalServerStudioReviewRouter } from './localServerStudioReviews';
import type { LocalServerDeps } from './localServerTypes';
import { createOperationRegistryForLocalServerDeps } from './runtimeOperationRegistry';
import {
  StudioRunService,
  type BuildStudioForTurn,
  type StudioRunServiceResult,
} from './studioRunService';
import type { SubagentToolEvent, StudioTurnEvent } from '@pinpawo/pet-agent';

type InflightRequest = InflightOperationRun;
type StudioHandleResult = StudioRunServiceResult | LocalStudioDueRunCompletion;

type StudioHandleCompletion = {
  runId: string;
  conversationId: string;
  idempotencyKey: string;
  workdir: string;
  outcome: 'done' | 'stopped';
  reply: string;
  finalPetRunId?: string;
  reason?: string;
};

export class LocalServerStudioHandler {
  private readonly reviewRouter: LocalServerStudioReviewRouter<WebSocket>;
  private readonly inflightRequests: InflightRequestController<WebSocket>;
  private readonly studioRunService: StudioRunService;
  private readonly studioDueRunScheduler?: LocalStudioDueRunScheduler;
  private readonly studioRequestQueue = new WeakMap<WebSocket, Promise<unknown>>();
  private readonly studioConnectionState = new WeakMap<WebSocket, { closed: boolean }>();

  constructor(options: {
    reviewRouter: LocalServerStudioReviewRouter<WebSocket>;
    inflightRequests: InflightRequestController<WebSocket>;
    studioRunService?: StudioRunService;
    buildStudio?: BuildStudioForTurn;
    studioDueRunScheduler?: LocalStudioDueRunScheduler;
  }) {
    this.reviewRouter = options.reviewRouter;
    this.inflightRequests = options.inflightRequests;
    this.studioRunService = options.studioRunService ?? new StudioRunService({
      buildStudio: options.buildStudio,
    });
    this.studioDueRunScheduler = options.studioDueRunScheduler;
  }

  routeHumanReviewResponse(ws: WebSocket, msg: HumanReviewResponseMessage) {
    return this.reviewRouter.routeResponse(ws, msg);
  }

  rejectDisconnected(ws: WebSocket) {
    this.reviewRouter.rejectAndDelete(ws, new Error('ws disconnected'));
    this.markStudioConnectionClosed(ws);
  }

  private markStudioConnectionClosed(ws: WebSocket) {
    const state = this.studioConnectionState.get(ws);
    if (state) {
      state.closed = true;
      return;
    }
    this.studioConnectionState.set(ws, { closed: true });
  }

  async handleStudioRequest(
    ws: WebSocket,
    msg: StudioRequestMessage,
    deps: LocalServerDeps,
  ) {
    return this.withQueuedStudioRequest(ws, () => this.handleStudioRequestInternal(ws, msg, deps));
  }

  private async handleStudioRequestInternal(
    ws: WebSocket,
    msg: StudioRequestMessage,
    deps: LocalServerDeps,
  ) {
    const { requestId, userRequest, runId: explicitRunId } = msg;
    const runId = explicitRunId?.trim() ? explicitRunId : requestId;
    const conversationId = msg.conversationId ?? runId;

    console.log(`[local-server] studio_request requestId=${requestId} userRequest="${userRequest.slice(0, 80)}"`);

    // 取消已有 inflight(避免跟 chat 重叠)
    const inflight = this.inflightRequests.start(ws, requestId, {
      interruptPrevious: false,
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

    const onProgress = (event: StudioTurnEvent) => {
      sendLocalAgentEvent(ws, {
        type: 'studio.progress',
        requestId,
        event,
      });
    };

    const onToolEvent = (payload: SubagentToolEvent) => {
      if (payload.event === 'on_runtime_event') {
        return;
      }
      this.sendStreamToolOperationEvent(ws, inflight, {
        event: payload.event,
        name: payload.name,
        toolCallId: payload.toolCallId,
        ...(payload.event === 'on_tool_start' ? { input: payload.input } : {}),
        ...(payload.event === 'on_tool_event' ? { data: payload.data } : {}),
        ...(payload.event === 'on_tool_end' ? { output: payload.output } : {}),
        ...(payload.event === 'on_tool_error' ? { error: payload.error } : {}),
        operation: payload.operation,
      } as StreamToolsPayload);
    };

    try {
      const result: StudioHandleResult = await (this.studioDueRunScheduler
        ? this.studioDueRunScheduler.submit({
          deps,
          requestId,
          runId,
          conversationId,
          userRequest,
          send,
          onProgress,
          onToolEvent: (payload) => {
            if (payload.event === 'on_runtime_event') {
              return;
            }
            onToolEvent(payload);
          },
          slot,
          signal: controller.signal,
        })
        : this.studioRunService.run({
          deps,
          runId,
          userRequest,
          conversationId,
          bridge: { send, requestId, slot },
          signal: controller.signal,
          onProgress,
          onToolEvent,
        }));

      const completion = this.toCompletion(result);

      if (controller.signal.aborted) {
        this.inflightRequests.finish(ws, inflight, 'interrupted');
        send({ type: 'studio_error', requestId, message: 'aborted by client' });
        return;
      }

      this.inflightRequests.finish(ws, inflight, 'completed');
      if (completion.outcome === 'done') {
        send({
          type: 'studio_response',
          requestId,
          outcome: 'done',
          reply: completion.reply,
          ...(completion.finalPetRunId ? { finalPetRunId: completion.finalPetRunId } : {}),
          workdir: completion.workdir,
          runId: completion.runId,
          conversationId: completion.conversationId,
          idempotencyKey: completion.idempotencyKey,
        });
      } else {
        send({
          type: 'studio_response',
          requestId,
          outcome: 'stopped',
          reply: completion.reply,
          reason: completion.reason,
          workdir: completion.workdir,
          runId: completion.runId,
          conversationId: completion.conversationId,
          idempotencyKey: completion.idempotencyKey,
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

  private withQueuedStudioRequest<T>(
    ws: WebSocket,
    run: () => Promise<T>,
  ): Promise<T> {
    const state = this.studioConnectionState.get(ws) ?? { closed: false };
    this.studioConnectionState.set(ws, state);
    const previous = this.studioRequestQueue.get(ws) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      if (state.closed) {
        return undefined as unknown as T;
      }
      return run();
    });
    this.studioRequestQueue.set(ws, current.then(() => undefined, () => undefined));
    return current;
  }

  private toCompletion(result: StudioHandleResult): StudioHandleCompletion {
    if ('turn' in result) {
      return {
        runId: result.runId,
        conversationId: result.conversationId,
        idempotencyKey: result.idempotencyKey,
        workdir: result.workdir,
        outcome: result.turn.outcome.outcome,
        reply: result.turn.outcome.reply,
        ...(result.turn.outcome.outcome === 'done'
          ? {
              finalPetRunId: result.turn.outcome.finalPetRunId,
            }
          : { reason: result.turn.outcome.reason }),
      };
    }

    return result;
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
