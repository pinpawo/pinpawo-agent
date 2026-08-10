import {
  type LocalAgentServerMessage,
  type StudioRequestMessage,
} from './localAgentProtocol';
import { type InflightOperationRun } from './inflightOperationRun';
import { InflightRequestController } from './inflightRequestController';
import {
  LocalStudioDueRunCompletion,
  LocalStudioDueRunScheduler,
} from './localStudioDueRunScheduler';
import { StudioNotConfiguredError } from './studio/studioRuntime';
import type { LocalServerDeps } from './localServerTypes';
import {
  StudioRunService,
  type BuildStudioForTurn,
  type StudioRunServiceResult,
} from './studioRunService';
import {
  StudioTurnEvent,
} from '@pinpawo/studio';
import type { AgentRuntimeEvent } from '@pinpawo/agent-session';

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

export type LocalServerStudioOutbound<Peer extends object> = {
  sendMessage: (peer: Peer, message: LocalAgentServerMessage) => boolean;
  sendEvent: (peer: Peer, event: AgentRuntimeEvent) => boolean;
};

export class LocalServerStudioHandler<Peer extends object> {
  private readonly inflightRequests: InflightRequestController<Peer>;
  private readonly outbound: LocalServerStudioOutbound<Peer>;
  private readonly studioRunService: StudioRunService;
  private readonly studioDueRunScheduler?: LocalStudioDueRunScheduler;
  private readonly studioRequestQueue = new WeakMap<Peer, Promise<unknown>>();
  private readonly studioConnectionState = new WeakMap<Peer, { closed: boolean }>();

  constructor(options: {
    inflightRequests: InflightRequestController<Peer>;
    outbound: LocalServerStudioOutbound<Peer>;
    studioRunService?: StudioRunService;
    buildStudio?: BuildStudioForTurn;
    studioDueRunScheduler?: LocalStudioDueRunScheduler;
  }) {
    this.inflightRequests = options.inflightRequests;
    this.outbound = options.outbound;
    this.studioRunService = options.studioRunService ?? new StudioRunService({
      buildStudio: options.buildStudio,
    });
    this.studioDueRunScheduler = options.studioDueRunScheduler;
  }

  rejectDisconnected(peer: Peer) {
    this.markStudioConnectionClosed(peer);
  }

  private markStudioConnectionClosed(peer: Peer) {
    const state = this.studioConnectionState.get(peer);
    if (state) {
      state.closed = true;
      return;
    }
    this.studioConnectionState.set(peer, { closed: true });
  }

  async handleStudioRequest(
    peer: Peer,
    msg: StudioRequestMessage,
    deps: LocalServerDeps,
  ) {
    return this.withQueuedStudioRequest(peer, () => this.handleStudioRequestInternal(peer, msg, deps));
  }

  private async handleStudioRequestInternal(
    peer: Peer,
    msg: StudioRequestMessage,
    deps: LocalServerDeps,
  ) {
    const { requestId, userRequest, runId: explicitRunId } = msg;
    const runId = explicitRunId?.trim() ? explicitRunId : requestId;
    const conversationId = msg.conversationId ?? runId;

    console.log(`[local-server] studio_request requestId=${requestId} userRequest="${userRequest.slice(0, 80)}"`);

    // 取消已有 inflight(避免跟 chat 重叠)
    const inflight = this.inflightRequests.start(peer, requestId);
    const { controller } = inflight;

    const send = (envelope: unknown) => {
      if (!envelope || typeof envelope !== 'object') return;
      this.outbound.sendMessage(peer, envelope as LocalAgentServerMessage);
    };

    const onProgress = (event: StudioTurnEvent) => {
      this.outbound.sendEvent(peer, {
        type: 'studio.progress',
        requestId,
        event,
      });
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
          signal: controller.signal,
        })
        : this.studioRunService.run({
          deps,
          runId,
          userRequest,
          conversationId,
          signal: controller.signal,
          onProgress,
        }));

      const completion = this.toCompletion(result);

      if (controller.signal.aborted) {
        this.inflightRequests.finish(peer, inflight, 'interrupted');
        send({ type: 'studio_error', requestId, message: 'aborted by client' });
        return;
      }

      this.inflightRequests.finish(peer, inflight, 'completed');
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
      this.inflightRequests.finish(peer, inflight, 'failed', err);
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
      this.inflightRequests.clear(peer, inflight);
    }
  }

  private withQueuedStudioRequest<T>(
    peer: Peer,
    run: () => Promise<T>,
  ): Promise<T> {
    const state = this.studioConnectionState.get(peer) ?? { closed: false };
    this.studioConnectionState.set(peer, state);
    const previous = this.studioRequestQueue.get(peer) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      if (state.closed) {
        return undefined as unknown as T;
      }
      return run();
    });
    this.studioRequestQueue.set(peer, current.then(() => undefined, () => undefined));
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
              // ws 协议字段名保持不变;Studio 侧现在叫 finalInvocationId。
              finalPetRunId: result.turn.outcome.finalInvocationId,
            }
          : { reason: result.turn.outcome.reason }),
      };
    }

    return result;
  }
}
