import {
  projectHumanReviewRequest,
  type PendingInterrupt,
} from '@pinpawo/pet-agent';
import { loadAgentContext } from '../contextLoader';
import {
  type ChatRequestMessage,
  type InterruptResumeMessage,
  type RunInterruptMessage,
} from '../wire/protocol';
import { projectPendingInterrupt } from '../conversation/pendingInterruptProjection';
import {
  type StreamToolsPayload,
} from './agentStreamEvents';
import {
  runAgentSessionTurn,
  type AgentSessionTurnRequest,
} from './chatSessionAdapter';
import {
  configureInflightOperationRegistry,
  overlayInflightDelegationOperations,
  type InflightOperationRun,
} from '../inflightOperationRun';
import { InflightRequestController } from '../inflightRequestController';
import { emitToolOperationEvent } from '../serverOperationEvents';
import { HostGraphService } from './agentGraphService';
import {
  ServerTuiSessionService,
  type ActivePendingInterrupt,
} from '../session/serverTuiSessions';
import type { TuiSessionRecord } from '../session/tuiSessionRegistry';
import type { ServerDeps } from '../serverTypes';
import { createOperationRegistryForAgentSetup } from '../runtimeOperationRegistry';
import {
  resolveHumanReviewAnswer,
  type HumanReviewResolutionSource,
} from '../pendingHumanReviewInterrupt';
import {
  agentErrorEvent,
  type AgentErrorNotice,
  type AgentRuntimeEvent,
  type PendingInterruptProjection,
} from '@pinpawo/agent-session';
import { AgentNoticeError } from './agentNoticeError';
import {
  classifyAgentRunFailure,
  fatalAgentRunNotice,
} from './agentRunFailure';
import { sendAgentSessionPeerEvent, type ServerPeer } from '../wire/peer';
import { ThreadInvocationCoordinator } from '../threadInvocationCoordinator';
import { describeAgentError } from './errorDiagnostics';
import type { Deliverable } from '@pinpawo/agent-contracts';
import { createArtifactChatHumanMessage } from './artifactImageInput';

type InflightRequest = InflightOperationRun;

type ChatTurnRequest = AgentSessionTurnRequest;
type RunAgentSessionTurn = typeof runAgentSessionTurn;
type ChatTurnSource =
  | { type: 'chat_request' }
  | { type: 'host_dispatch' }
  | HumanReviewResolutionSource;

export type HostTurnOutcome =
  | { outcome: 'completed'; reply: string; pendingInterrupt: null; error?: never }
  | { outcome: 'waiting'; pendingInterrupt: PendingInterruptProjection; reply?: never; error?: never }
  | { outcome: 'interrupted'; pendingInterrupt?: null; reply?: never; error?: never }
  | { outcome: 'failed' | 'fatal_failed'; error: unknown; pendingInterrupt?: PendingInterruptProjection | null; settlementFailed?: true; reply?: never };

/** A Host adapter may attribute an already validated review to a Dispatch. */
export type RunReviewTurn = (
  session: ChatTurnTarget,
  request: Extract<ChatTurnRequest, { kind: 'resume' }>,
  run: (runner?: RunAgentSessionTurn) => Promise<HostTurnOutcome>,
) => Promise<HostTurnOutcome>;

/** A Session resolved at the Host boundary, before loading or running the graph. */
export type ChatTurnTarget = TuiSessionRecord;

export type PendingInterruptSnapshot = {
  sessionId?: string;
  pendingInterrupt: PendingInterruptProjection;
};

export function isToolProtocolHistoryError(value: unknown): boolean {
  const text = value instanceof Error
    ? `${value.name}\n${value.message}\n${value.stack ?? ''}`
    : String(value ?? '');
  return text.includes('INVALID_TOOL_RESULTS')
    || text.includes("An assistant message with 'tool_calls' must be followed by tool messages")
    || text.includes('insufficient tool messages following tool_calls message');
}

export class ServerChatHandler {
  private readonly graphService: HostGraphService;
  private readonly tuiSessions: ServerTuiSessionService;
  private readonly inflightRequests: InflightRequestController<ServerPeer>;
  private readonly loadContext: typeof loadAgentContext;
  private readonly runAgentTurn: RunAgentSessionTurn;
  private readonly runReviewTurn?: RunReviewTurn;
  private readonly publishRuntimeEvent: (
    origin: ServerPeer,
    event: AgentRuntimeEvent,
  ) => void;
  private readonly interruptHostRun?: (requestId: string) => boolean;
  private readonly threadInvocations = new ThreadInvocationCoordinator();
  private closed = false;

  constructor(options: {
    graphService: HostGraphService;
    tuiSessions: ServerTuiSessionService;
    inflightRequests: InflightRequestController<ServerPeer>;
    loadContext?: typeof loadAgentContext;
    runAgentTurn?: RunAgentSessionTurn;
    runReviewTurn?: RunReviewTurn;
    publishRuntimeEvent?: (
      origin: ServerPeer,
      event: AgentRuntimeEvent,
    ) => void;
    interruptHostRun?: (requestId: string) => boolean;
  }) {
    this.graphService = options.graphService;
    this.tuiSessions = options.tuiSessions;
    this.inflightRequests = options.inflightRequests;
    this.loadContext = options.loadContext ?? loadAgentContext;
    this.runAgentTurn = options.runAgentTurn ?? runAgentSessionTurn;
    this.runReviewTurn = options.runReviewTurn;
    this.publishRuntimeEvent = options.publishRuntimeEvent
      ?? ((peer, event) => {
        sendAgentSessionPeerEvent(peer, event);
      });
    this.interruptHostRun = options.interruptHostRun;
  }

  close(): void {
    this.closed = true;
  }

  buildPendingInterruptSnapshot(
    _deps: ServerDeps,
    pending: ActivePendingInterrupt | null,
  ): PendingInterruptSnapshot | null {
    if (!pending) {
      return null;
    }
    return {
      sessionId: pending.sessionId,
      pendingInterrupt: projectPendingInterrupt(pending),
    };
  }

  private sendClosedReviewError(peer: ServerPeer, requestId: string) {
    sendAgentSessionPeerEvent(peer, agentErrorEvent(requestId, { code: 'interrupt_closed' }));
  }

  async handleChatRequest(
    peer: ServerPeer,
    msg: ChatRequestMessage,
    deps: ServerDeps,
  ) {
    await this.runChatRequest(peer, {
      kind: 'user_message',
      requestId: msg.requestId,
      message: msg.message,
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
    }, deps, { type: 'chat_request' });
  }

  /**
   * The one resume entry point. Identity is checked here; the value belongs to
   * the interrupt's kind. A review's value is validated against the
   * authoritative checkpoint first, because a malformed decision would leave a
   * tool call unanswered.
   *
   * With a target, the interrupt is read from and resumed in that session's
   * own thread; the active session is neither read nor changed.
   */
  async handleInterruptResume(
    peer: ServerPeer,
    msg: InterruptResumeMessage,
    deps: ServerDeps,
    target?: ChatTurnTarget,
    onReceipt?: (current: boolean) => void,
  ) {
    const session = target ?? this.tuiSessions.getActiveSession(deps.petId);
    const pending = await this.tuiSessions.readSessionPendingInterrupt(deps, session);
    const current = pending?.interruptId === msg.interruptId;
    onReceipt?.(current);
    if (!current) {
      this.sendClosedReviewError(peer, msg.requestId);
      return;
    }
    const answer = resolveHumanReviewAnswer(pending.payload.reviews, msg.value);
    if ('code' in answer) {
      if (answer.code === 'interrupt_closed') this.sendClosedReviewError(peer, msg.requestId);
      else this.publishRuntimeEvent(peer, agentErrorEvent(msg.requestId, { code: answer.code }));
      return;
    }
    // The implicit TUI target must still be selected, but Studio's explicit
    // target is independent of which Session the TUI currently has open.
    if (!target && this.tuiSessions.peekActiveSessionId(deps.petId) !== session.id) {
      sendAgentSessionPeerEvent(peer, agentErrorEvent(msg.requestId, { code: 'interrupt_wrong_session' }));
      return;
    }
    if (!peer.isConnected()) return;

    const request = {
      kind: 'resume' as const,
      requestId: msg.requestId,
      resume: { interruptId: pending.interruptId, value: answer.resume },
    };
    const run = (runner?: RunAgentSessionTurn) =>
      this.runChatRequest(peer, request, deps, answer.source, session, runner, !target);
    if (this.runReviewTurn) await this.runReviewTurn(session, request, run);
    else await run();
  }

  /**
   * A Host-initiated turn, such as a resident Pet's dispatch. It runs through
   * the same pipeline as a chat request; it only has no client to answer, so
   * the outcome is returned instead of being reported to a requester.
   */
  async runHostTurn(
    peer: ServerPeer,
    turn: { requestId: string; message: string; artifactReferences?: readonly Deliverable[]; runAgentTurn?: RunAgentSessionTurn },
    deps: ServerDeps,
    target?: ChatTurnTarget,
  ): Promise<HostTurnOutcome> {
    return this.runChatRequest(peer, {
      kind: 'user_message',
      requestId: turn.requestId,
      message: turn.message,
      ...(turn.artifactReferences ? { artifactReferences: turn.artifactReferences } : {}),
    }, deps, { type: 'host_dispatch' }, target, turn.runAgentTurn);
  }

  async handleRunInterrupt(
    peer: ServerPeer,
    msg: RunInterruptMessage,
    deps: ServerDeps,
  ) {
    const inflight = this.inflightRequests.interrupt(peer, { requestId: msg.requestId });
    if (inflight) {
      return inflight;
    }
    if (this.interruptHostRun?.(msg.requestId)) {
      peer.send({
        type: 'interrupting',
        requestId: msg.requestId,
        message: 'interrupting',
      });
      return { requestId: msg.requestId };
    }
    // No run is in flight, so the run already settled into an interrupt before
    // the interface observed it. Re-announce that interrupt and stop: the Host
    // must not turn a stop request into a resume decision on the person's
    // behalf. The interface reconciles and the person acts on what is pending.
    const pending = await this.tuiSessions.readActivePendingInterrupt(deps);
    const snapshot = pending
      ? this.buildPendingInterruptSnapshot(deps, pending)
      : null;
    if (snapshot) {
      this.publishRuntimeEvent(peer, {
        type: 'interrupt.requested',
        requestId: msg.requestId,
        pendingInterrupt: snapshot.pendingInterrupt,
      });
    }
    return null;
  }

  private async runChatRequest(
    peer: ServerPeer,
    request: ChatTurnRequest,
    deps: ServerDeps,
    source: ChatTurnSource,
    target?: ChatTurnTarget,
    runAgentTurn = this.runAgentTurn,
    allowHistoryRecovery = !target,
  ): Promise<HostTurnOutcome> {
    // Resume validation awaits checkpoint reads before registering an inflight
    // run. Close may already have aborted every registered run in that gap.
    // Fence this final admission synchronously; an unstarted review stays pending.
    if (this.closed) return { outcome: 'interrupted' };
    const { requestId } = request;
    const message = request.kind === 'user_message' ? request.message : '';

    if (source.type === 'chat_request' || source.type === 'host_dispatch') {
      console.log(`[chat-host] ${source.type} requestId=${requestId} message="${message.slice(0, 80)}"`);
    } else if (source.type === 'review_decision') {
      console.log(
        `[chat-host] review decision requestId=${requestId} `
        + `interactionId=${source.interactionId} option=${source.selectedOptionId}`
        + (source.decisionCount ? ` decisions=${source.decisionCount}` : ''),
      );
    } else {
      console.log(
        `[chat-host] review cancel requestId=${requestId} `
        + `interactionId=${source.interactionId} action=interrupt_run`,
      );
    }
    const threadId = target?.threadId ?? this.tuiSessions.getChatThreadId(deps.petId);
    const refreshSummary = () => target
      ? this.tuiSessions.refreshSessionSummary(deps, target)
      : this.tuiSessions.refreshActiveSessionSummary(deps);
    const inflight = this.inflightRequests.start(peer, requestId);
    const { controller } = inflight;
    const invocation = this.threadInvocations.enqueue({
      threadId,
      requestId,
      signal: controller.signal,
      abort: () => controller.abort(),
    });
    const isCurrent = invocation.isCurrent;
    let runStarted = false;
    let interruptedFinalized = false;
    let turnSetup: ReturnType<ServerTuiSessionService['buildChatSetup']> | undefined;
    /**
     * Cancellation creates no interrupt. Preserve only a native review
     * that was already pending when the interruption arrived.
     */
    const settleInterrupted = async (): Promise<HostTurnOutcome> => {
      // A settlement that fails leaves the thread in an unknown state, so it
      // takes the failure path rather than being reported as a clean
      // interruption. The caller decides how that failure is surfaced.
      const setup = turnSetup ?? this.tuiSessions.buildChatSetup(deps, await this.loadContext(deps.petId), threadId);
      let settled: PendingInterrupt | null;
      try {
        settled = await this.graphService.settleAbortedRun(setup);
      } catch (error) {
        console.error('[chat-host] failed to confirm a cancelled run:', error);
        const failure = await reportFailure(error, runStarted && !invocation.isSuperseded());
        return { ...failure, settlementFailed: true };
      }
      const usage = this.graphService.readSessionTokenUsage?.(setup);
      if (usage && !invocation.isSuperseded()) {
        this.publishRuntimeEvent(peer, { type: 'usage.updated', requestId, usage });
      }
      if (settled) {
        const pendingInterrupt = projectPendingInterrupt(settled);
        this.inflightRequests.finish(peer, inflight, 'interrupted');
        this.publishRuntimeEvent(peer, {
          type: 'interrupt.requested',
          requestId,
          pendingInterrupt,
        });
        this.inflightRequests.clear(peer, inflight);
        await refreshSummary();
        return { outcome: 'waiting', pendingInterrupt };
      }
      finalizeInterrupted();
      return { outcome: 'interrupted', pendingInterrupt: null };
    };
    // The one interrupted finalization for this request. An abort, a
    // superseding request ends here: open operations close first, then the
    // run reports interrupted.
    const finalizeInterrupted = () => {
      if (interruptedFinalized) return;
      interruptedFinalized = true;
      this.inflightRequests.finish(peer, inflight, 'interrupted');
      if (runStarted) {
        this.publishRuntimeEvent(peer, {
          type: 'run.interrupted',
          requestId,
          message: 'Run interrupted.',
        });
      }
      this.inflightRequests.clear(peer, inflight);
    };

    /**
     * The one failure path for this request: a run that threw, and a
     * cancellation whose settlement could not complete. Both leave work in an
     * unknown state, so neither is reported as a clean interruption.
     */
    const reportFailure = async (
      err: unknown,
      isStillCurrent: boolean,
      pendingInterrupt?: PendingInterruptProjection | null,
    ): Promise<Extract<HostTurnOutcome, { error: unknown }>> => {
      this.inflightRequests.finish(peer, inflight, 'failed', err);
      this.inflightRequests.clear(peer, inflight);
      const diagnostics = describeAgentError(err);
      console.error(
        '[chat-host] chat error:',
        err instanceof Error ? (err.stack ?? err.message) : err,
        JSON.stringify({ requestId, diagnostics }),
      );
      // A history the provider rejects is switched away from, never deleted: the old
      // session stays in the list. Studio exact-session turns never switch the TUI.
      const detail = err instanceof Error ? err.message : 'internal error';
      let protocolRecovery: AgentErrorNotice | null = null;
      if (allowHistoryRecovery && isToolProtocolHistoryError(err)) {
        try {
          this.tuiSessions.createNewSession(deps.petId);
          protocolRecovery = { code: 'history_rejected_session_switched', params: { detail } };
          console.warn(`[chat-host] started a new TUI chat session after tool protocol error requestId=${requestId}`);
        } catch (switchError) {
          const reason = switchError instanceof Error ? switchError.message : String(switchError);
          protocolRecovery = { code: 'history_rejected_switch_failed', params: { detail, reason } };
          console.warn('[chat-host] failed to start a new TUI chat session after tool protocol error:', reason);
        }
      }
      const failure = classifyAgentRunFailure(err);
      if (isStillCurrent) {
        const notice = protocolRecovery
          ?? (failure.kind === 'fatal' ? fatalAgentRunNotice(failure) : null)
          ?? (err instanceof AgentNoticeError ? err.notice : null);
        this.publishRuntimeEvent(peer, notice
          ? agentErrorEvent(requestId, notice, { diagnostics })
          : { type: 'error', requestId, message: detail, diagnostics });
      }
      return { outcome: failure.kind === 'fatal' ? 'fatal_failed' : 'failed', error: err, pendingInterrupt };
    };

    const settleCancellation = async () => {
      try {
        return await settleInterrupted();
      } catch (error) {
        console.error('[chat-host] failed to settle an aborted run:', error);
        // A started run still owes its observers a terminal event unless
        // a replacement run owns the thread now.
        return reportFailure(error, runStarted && !invocation.isSuperseded());
      }
    };

    try {
      await invocation.waitForTurn();
      if (!isCurrent()) {
        finalizeInterrupted();
        return { outcome: 'interrupted' };
      }
      this.publishRuntimeEvent(peer, {
        type: 'run.started',
        requestId,
        initiator: source.type === 'host_dispatch' ? 'host' : 'client',
        ...(request.kind === 'user_message'
          ? { input: { role: 'user', text: request.message } as const }
          : {}),
      });
      runStarted = true;
      const ctx = await this.loadContext(deps.petId);
      if (!isCurrent()) {
        finalizeInterrupted();
        return { outcome: 'interrupted' };
      }

      const setup = turnSetup = this.tuiSessions.buildChatSetup(deps, ctx, threadId);
      configureInflightOperationRegistry(
        inflight,
        createOperationRegistryForAgentSetup(setup),
      );
      setup.input.signal = controller.signal;
      const result = await runAgentTurn({
        request,
        setup,
        graphService: this.graphService,
        isCurrent,
        emitEvent: (event) => {
          if (!isCurrent()) return;
          this.publishRuntimeEvent(peer, event);
        },
        emitToolEvent: (event) => {
          if (!isCurrent()) return;
          this.sendStreamToolOperationEvent(peer, inflight, event);
        },
        acceptDelegationOperations: (operations) => {
          if (!isCurrent()) return;
          overlayInflightDelegationOperations(inflight, operations);
        },
        ...(request.kind === 'user_message'
          ? {
              prepareUserMessage: () => request.artifactReferences?.length
                ? createArtifactChatHumanMessage(request.message, request.artifactReferences, deps.artifactStore, {
                  allowImages: (setup.graphConfig.modelInputModalities ?? ['text']).includes('image'),
                  signal: controller.signal,
                })
                : this.tuiSessions.createUserMessage(deps, request.message, request.attachments ?? []),
            }
          : {}),
      });
      if (result.status === 'waiting') {
        // Every kind settles here. The run's own operations close, and the
        // interrupt.requested event already told the interface what it is
        // waiting on and under which id.
        this.inflightRequests.finish(peer, inflight, 'interrupted');
        await refreshSummary();
        console.log(`[chat-host] interrupt.requested requestId=${requestId}`);
        this.inflightRequests.clear(peer, inflight);
        return { outcome: 'waiting', pendingInterrupt: projectPendingInterrupt(result.pendingInterrupt) };
      }
      if (result.status === 'interrupted') {
        return await settleCancellation();
      }
      this.inflightRequests.finish(peer, inflight, 'completed');
      this.inflightRequests.clear(peer, inflight);
      await refreshSummary();

      console.log(`[chat-host] message.completed sent requestId=${requestId} reply="${result.reply.slice(0, 100)}"`);
      return { outcome: 'completed', reply: result.reply, pendingInterrupt: null };
    } catch (err) {
      const aborted = controller.signal.aborted
        || (err instanceof Error && err.name === 'AbortError');
      if (aborted) {
        console.warn(`[chat-host] chat interrupted requestId=${requestId}`);
        return await settleCancellation();
      }
      let pendingInterrupt: PendingInterruptProjection | null | undefined;
      if (request.kind === 'resume' && turnSetup && this.runReviewTurn) {
        // A failure and a pending review can coexist. An unreadable state is
        // unknown, not an empty checkpoint; preserve the original failure.
        try {
          const pending = await this.graphService.settleAbortedRun(turnSetup);
          pendingInterrupt = pending ? projectPendingInterrupt(pending) : null;
        } catch (readError) {
          console.warn('[chat-host] failed to confirm review state after resume failure:', readError);
        }
      }
      return await reportFailure(err, isCurrent(), pendingInterrupt);
    } finally {
      invocation.settle();
    }
  }

  private sendStreamToolOperationEvent(
    peer: ServerPeer,
    inflight: InflightRequest,
    payload: StreamToolsPayload,
  ) {
    emitToolOperationEvent({
      run: inflight,
      payload,
      // Trusted local peer: include raw input/output so the UI can render diffs etc.
      emit: (event) => this.publishRuntimeEvent(peer, event),
    });
  }
}
