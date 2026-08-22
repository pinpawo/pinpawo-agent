import {
  applySessionSnapshot,
  reduceSession,
  type AgentLocalAttachment,
  type ChatRequestMessage,
  type AgentSession,
  type AgentSessionSnapshot,
  type BuiltinGlobalReviewPolicyMode,
  type ReviewResponse,
  type ToolAuthorizationSafetyLevel,
} from '@pinpawo/agent-session';
import { formatAttachmentDisplayText } from '../attachments/attachmentModel';
import {
  studioAcceptedMessage,
  studioErrorMessage,
  studioUserMessage,
} from './studioProjection';
import { prepareReviewDecision } from './reviewDecision';
import {
  RuntimeConfigCoordinator,
  type UpdateGlobalReviewPolicyResult,
} from './runtimeConfigCoordinator';
import {
  SessionCommandCoordinator,
  type CompactSessionResult,
  type ResumeSessionResult,
  type StartNewSessionResult,
} from './sessionCommandCoordinator';
import {
  reconcileSessionSnapshot,
} from './sessionSnapshot';
import {
  SessionTransportCoordinator,
  type SessionApplicationServerMessage,
} from './sessionTransportCoordinator';
import {
  ModelProfileCoordinator,
  type ListModelProfilesResult,
} from './modelProfileCoordinator';
import type {
  CancelReviewResult,
  InterruptResolvedReviewResult,
  InterruptRunResult,
  SubmitChatResult,
  SubmitReviewResponseResult,
  TuiConnectionStatus,
  TuiSessionControllerOptions,
  TuiSessionState,
} from './sessionControllerTypes';

export type {
  CompactSessionResult,
  ResumeSessionResult,
  StartNewSessionResult,
} from './sessionCommandCoordinator';
export type {
  UpdateGlobalReviewPolicyResult,
} from './runtimeConfigCoordinator';
export {
  ModelProfileCommandError,
} from './modelProfileCoordinator';
export type {
  ListModelProfilesResult,
} from './modelProfileCoordinator';
export type {
  CancelReviewResult,
  InterruptResolvedReviewResult,
  InterruptRunResult,
  SubmitChatResult,
  SubmitReviewResponseResult,
  TuiConnectionStatus,
  TuiSessionControllerOptions,
  TuiSessionState,
} from './sessionControllerTypes';

type ActiveDelegationTransition = NonNullable<
  ChatRequestMessage['activeDelegationTransition']
>;

const DEFAULT_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 5_000;
const DEFAULT_SESSION_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_SESSION_COMPACT_TIMEOUT_MS = 120_000;

export class TuiSessionController {
  private readonly now: () => number;
  private readonly requestIdFactory: () => string;
  private readonly transport: SessionTransportCoordinator;
  private readonly listeners = new Set<(state: TuiSessionState) => void>();
  private readonly sessionCommands: SessionCommandCoordinator;
  private readonly modelProfiles: ModelProfileCoordinator;
  private readonly runtimeConfig: RuntimeConfigCoordinator;
  private state: TuiSessionState = {
    connection: 'idle',
    session: createPendingSession(),
  };

  constructor(options: TuiSessionControllerOptions) {
    this.now = options.now ?? Date.now;
    this.requestIdFactory = options.requestIdFactory ?? (() => crypto.randomUUID());
    const sessionCommandTimeoutMs = options.sessionCommandTimeoutMs
      ?? DEFAULT_SESSION_COMMAND_TIMEOUT_MS;
    const setTimer = options.setTimer ?? setTimeout;
    const clearTimer = options.clearTimer ?? clearTimeout;
    this.transport = new SessionTransportCoordinator({
      connectionFactory: options.connectionFactory,
      requestIdFactory: this.requestIdFactory,
      reconnectDelaysMs: options.reconnectDelaysMs?.length
        ? options.reconnectDelaysMs
        : DEFAULT_RECONNECT_DELAYS_MS,
      snapshotTimeoutMs: options.snapshotTimeoutMs
        ?? DEFAULT_SNAPSHOT_TIMEOUT_MS,
      setTimer,
      clearTimer,
      onConnection: (connection, detail) => {
        this.setConnection(connection, detail);
      },
      onSnapshot: (snapshot, reason) => {
        const session = reconcileSessionSnapshot(
          this.state.session,
          snapshot,
          reason,
          this.now(),
        );
        if (reason === 'startup' || reason === 'reconnect') {
          this.state = {
            connection: 'ready',
            session,
          };
          this.notify();
        } else {
          this.updateSession(session);
        }
      },
      onMessage: (message) => this.handleMessage(message),
      onDisconnected: () => {
        this.sessionCommands.cancelAll('local-agent disconnected');
        this.modelProfiles.cancelAll('local-agent disconnected');
        this.runtimeConfig.cancel('local-agent disconnected');
      },
    });
    this.sessionCommands = new SessionCommandCoordinator({
      requestIdFactory: this.requestIdFactory,
      send: (message) => this.transport.send(message),
      getUnavailableReason: () => this.sessionCommandUnavailable(),
      getSessionId: () => this.state.session.sessionId,
      onSnapshot: (snapshot) => {
        this.transport.clearSnapshotRequests();
        this.updateSession(applySessionSnapshot(
          this.state.session,
          snapshot,
          { observedAt: this.now() },
        ));
      },
      timeoutMs: sessionCommandTimeoutMs,
      compactTimeoutMs: options.sessionCompactTimeoutMs
        ?? DEFAULT_SESSION_COMPACT_TIMEOUT_MS,
      setTimer,
      clearTimer,
    });
    this.modelProfiles = new ModelProfileCoordinator({
      requestIdFactory: this.requestIdFactory,
      send: (message) => this.transport.send(message),
      getUnavailableReason: () => this.modelCommandUnavailable(),
      getSessionId: () => this.state.session.sessionId,
      onSelected: (snapshot) => {
        this.updateSession(applySessionSnapshot(
          this.state.session,
          snapshot,
          {
            observedAt: this.now(),
            preserveOmittedTokenUsage: true,
            preserveOmittedSessionTokenUsage: true,
          },
        ));
      },
      timeoutMs: sessionCommandTimeoutMs,
      setTimer,
      clearTimer,
    });
    this.runtimeConfig = new RuntimeConfigCoordinator({
      requestIdFactory: this.requestIdFactory,
      send: (message) => this.transport.send(message),
      getUnavailableReason: () => this.runtimeConfigUpdateUnavailable(),
      onUpdated: (globalReviewPolicyMode, autoAuthorizationSafetyLevel) => {
        this.updateSession({
          ...this.state.session,
          runtime: {
            ...this.state.session.runtime,
            globalReviewPolicyMode,
            autoAuthorizationSafetyLevel,
          },
        });
      },
      timeoutMs: sessionCommandTimeoutMs,
      setTimer,
      clearTimer,
    });
  }

  getState() {
    return this.state;
  }

  subscribe(listener: (state: TuiSessionState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start() {
    this.transport.start();
  }

  stop() {
    this.sessionCommands.cancelAll('session command cancelled');
    this.modelProfiles.cancelAll('model command cancelled');
    this.runtimeConfig.cancel('runtime config update cancelled');
    this.transport.stop();
  }

  submitChat(
    message: string,
    attachments: readonly AgentLocalAttachment[] = [],
  ): SubmitChatResult {
    return this.submitChatWithTransition(
      message,
      attachments,
      'supersede_active',
    );
  }

  continueActiveDelegation(message: string): SubmitChatResult {
    return this.submitChatWithTransition(message, [], 'resume_active');
  }

  refreshSession(): { ok: true } | { ok: false; reason: 'not-ready' } {
    if (this.state.connection !== 'ready' || !this.transport.isConnected()) {
      return { ok: false, reason: 'not-ready' };
    }
    this.transport.requestCompletionSnapshot();
    return { ok: true };
  }

  private submitChatWithTransition(
    message: string,
    attachments: readonly AgentLocalAttachment[],
    activeDelegationTransition?: ActiveDelegationTransition,
  ): SubmitChatResult {
    if (!message.trim() && attachments.length === 0) {
      return { ok: false, reason: 'empty' };
    }
    if (this.state.connection !== 'ready' || !this.transport.isConnected()) {
      return { ok: false, reason: 'not-ready' };
    }
    if (
      this.state.session.activeRun
      || this.sessionCommands.hasPending()
      || this.modelProfiles.hasPending()
      || this.runtimeConfig.hasPending()
    ) {
      return { ok: false, reason: 'busy' };
    }

    const requestId = this.requestIdFactory();
    if (!this.transport.send({
      type: 'chat_request',
      requestId,
      message,
      ...(attachments.length ? { attachments: [...attachments] } : {}),
      ...(activeDelegationTransition ? { activeDelegationTransition } : {}),
    })) {
      return { ok: false, reason: 'send-failed' };
    }
    this.updateSession(reduceSession(this.state.session, {
      type: 'user.accepted',
      requestId,
      kind: 'chat',
      text: formatAttachmentDisplayText(message, attachments),
    }, { observedAt: this.now() }));
    return { ok: true, requestId };
  }

  submitStudio(
    userRequest: string,
    conversationId: string,
  ): SubmitChatResult {
    const request = userRequest.trim();
    if (!request) {
      return { ok: false, reason: 'empty' };
    }
    if (this.state.connection !== 'ready' || !this.transport.isConnected()) {
      return { ok: false, reason: 'not-ready' };
    }
    if (
      this.state.session.activeRun
      || this.sessionCommands.hasPending()
      || this.modelProfiles.hasPending()
      || this.runtimeConfig.hasPending()
    ) {
      return { ok: false, reason: 'busy' };
    }

    const requestId = this.requestIdFactory();
    if (!this.transport.send({
      type: 'studio_request',
      requestId,
      userRequest: request,
      conversationId,
    })) {
      return { ok: false, reason: 'send-failed' };
    }
    this.updateSession(reduceSession(this.state.session, {
      type: 'user.accepted',
      requestId,
      kind: 'studio',
      text: studioUserMessage(request),
    }, { observedAt: this.now() }));
    return { ok: true, requestId };
  }

  interruptRun(): InterruptRunResult {
    if (this.state.connection !== 'ready' || !this.transport.isConnected()) {
      return { ok: false, reason: 'not-ready' };
    }
    const run = this.state.session.activeRun;
    if (!run) {
      return { ok: false, reason: 'idle' };
    }
    if (run.state === 'pending_interrupt') {
      return { ok: false, reason: 'review-active' };
    }
    if (run.state === 'interrupting') {
      return { ok: false, reason: 'already-interrupting' };
    }
    if (!this.transport.send({
      type: 'run.interrupt',
      requestId: run.requestId,
    })) {
      return { ok: false, reason: 'send-failed' };
    }
    this.updateSession(reduceSession(
      this.state.session,
      {
        type: 'run.interrupting',
        requestId: run.requestId,
      },
      { observedAt: this.now() },
    ));
    return { ok: true, requestId: run.requestId };
  }

  interruptResolvedReview(params: {
    interruptId: string;
  }): InterruptResolvedReviewResult {
    if (this.state.connection !== 'ready' || !this.transport.isConnected()) {
      return { ok: false, reason: 'not-ready' };
    }
    const run = this.state.session.activeRun;
    if (!run || run.state !== 'pending_interrupt') {
      return { ok: false, reason: 'closed' };
    }
    if (
      !run.requestId
      || run.pendingInterrupt.interruptId !== params.interruptId
    ) {
      return { ok: false, reason: 'stale' };
    }
    if (!this.transport.send({
      type: 'run.interrupt',
      requestId: run.requestId,
    })) {
      return { ok: false, reason: 'send-failed' };
    }
    return { ok: true, requestId: run.requestId };
  }

  startNewSession(): Promise<StartNewSessionResult> {
    return this.sessionCommands.startNewSession();
  }

  listSessions() {
    return this.sessionCommands.listSessions();
  }

  resumeSession(sessionId: string): Promise<ResumeSessionResult> {
    return this.sessionCommands.resumeSession(sessionId);
  }

  compactSession(): Promise<CompactSessionResult> {
    const request = this.sessionCommands.compactSession();
    if (!this.sessionCommands.hasPending()) {
      return request;
    }

    this.state = {
      ...this.state,
      pendingSessionCommand: 'compact',
    };
    this.notify();
    return request.finally(() => {
      if (this.state.pendingSessionCommand !== 'compact') return;
      this.state = {
        ...this.state,
        pendingSessionCommand: undefined,
      };
      this.notify();
    });
  }

  updateGlobalReviewPolicy(
    globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode,
    autoAuthorizationSafetyLevel: ToolAuthorizationSafetyLevel,
  ): Promise<UpdateGlobalReviewPolicyResult> {
    return this.runtimeConfig.updateGlobalReviewPolicy(
      globalReviewPolicyMode,
      autoAuthorizationSafetyLevel,
    );
  }

  listModelProfiles(): Promise<ListModelProfilesResult> {
    return this.modelProfiles.list();
  }

  selectModelProfile(
    modelProfileId: string,
    expectedSessionId: string,
  ): Promise<AgentSessionSnapshot> {
    return this.modelProfiles.select(modelProfileId, expectedSessionId);
  }

  cancelModelProfileList() {
    this.modelProfiles.cancelLists();
  }

  submitReviewResponse(params: {
    interruptId: string;
    responses: readonly ReviewResponse[];
    optionId: string;
    inputText?: string;
  }): SubmitReviewResponseResult {
    if (!this.reviewTransportReady()) {
      return { ok: false, reason: 'not-ready' };
    }
    const run = this.state.session.activeRun;
    if (!run || run.state !== 'pending_interrupt') {
      return { ok: false, reason: 'closed' };
    }
    if (run.pendingInterrupt.interruptId !== params.interruptId) {
      return { ok: false, reason: 'stale' };
    }
    const prepared = prepareReviewDecision({
      pendingInterrupt: run.pendingInterrupt,
      responses: params.responses,
      optionId: params.optionId,
      inputText: params.inputText,
    });
    if (!prepared.ok) {
      return prepared;
    }
    if (!prepared.shouldSend) {
      return {
        ok: true,
        status: 'advanced',
        decision: prepared.decision,
        responses: prepared.responses,
      };
    }
    const requestId = this.requestIdFactory();
    if (!this.transport.send({
      type: 'human_review_response',
      requestId,
      interruptId: run.pendingInterrupt.interruptId,
      responses: prepared.responses,
    })) {
      return { ok: false, reason: 'send-failed' };
    }
    this.updateSession(reduceSession(this.state.session, {
      type: 'review.resolution.accepted',
      requestId,
      interruptId: run.pendingInterrupt.interruptId,
    }, { observedAt: this.now() }));
    return {
      ok: true,
      status: 'sent',
      decision: prepared.decision,
      responses: prepared.responses,
    };
  }

  cancelReview(params: {
    interruptId: string;
  }): CancelReviewResult {
    if (!this.reviewTransportReady()) {
      return { ok: false, reason: 'not-ready' };
    }
    const run = this.state.session.activeRun;
    if (!run || run.state !== 'pending_interrupt') {
      return { ok: false, reason: 'closed' };
    }
    if (run.pendingInterrupt.interruptId !== params.interruptId) {
      return { ok: false, reason: 'stale' };
    }
    const requestId = this.requestIdFactory();
    if (!this.transport.send({
      type: 'review.cancel',
      requestId,
      interruptId: run.pendingInterrupt.interruptId,
    })) {
      return { ok: false, reason: 'send-failed' };
    }
    this.updateSession(reduceSession(this.state.session, {
      type: 'review.resolution.accepted',
      requestId,
      interruptId: run.pendingInterrupt.interruptId,
    }, { observedAt: this.now() }));
    return { ok: true };
  }

  private handleMessage(message: SessionApplicationServerMessage) {
    if (
      message.type === 'model.list.result'
      || message.type === 'model.select.result'
      || message.type === 'model.select.error'
    ) {
      this.modelProfiles.handleMessage(message);
      return;
    }

    if (
      message.type === 'runtime_config.result'
      || message.type === 'runtime_config.error'
    ) {
      this.runtimeConfig.handleMessage(message);
      return;
    }

    if (
      message.type === 'session.list.result'
      || message.type === 'session.new.result'
      || message.type === 'session.resume.result'
      || message.type === 'session.compact.result'
      || message.type === 'session.error'
    ) {
      this.sessionCommands.handleMessage(message);
      return;
    }

    if (message.type === 'event') {
      // Studio 进度不再往这条会话里投影:推模型下提交即返回,activeRun 早就
      // 结束了,按 requestId 匹配恒不成立 —— 那是拉模型留下的形状。进度归
      // 插件自己的视图,studio 不代它呈现。
      this.updateSession(reduceSession(this.state.session, {
        type: 'runtime.event',
        event: message.event,
      }, { observedAt: this.now() }));
      if (
        message.event.type === 'message.completed'
        || message.event.type === 'error'
      ) {
        this.transport.requestCompletionSnapshot();
      }
      return;
    }

    if (message.type === 'studio_response') {
      this.updateSession(reduceSession(this.state.session, {
        type: 'run.finished',
        requestId: message.requestId,
        messages: studioAcceptedMessage(message),
      }, { observedAt: this.now() }));
      return;
    }

    if (message.type === 'studio_error') {
      this.updateSession(reduceSession(this.state.session, {
        type: 'run.finished',
        requestId: message.requestId,
        messages: [studioErrorMessage(
          message.requestId,
          message.message,
        )],
      }, { observedAt: this.now() }));
      return;
    }

    if (message.type === 'interrupting') {
      this.updateSession(reduceSession(this.state.session, {
        type: 'run.interrupting',
        requestId: message.requestId,
      }, { observedAt: this.now() }));
      return;
    }

    if (message.type === 'interrupted') {
      this.updateSession(reduceSession(this.state.session, {
        type: 'run.finished',
        requestId: message.requestId,
        messages: [{
          role: 'system',
          requestId: message.requestId,
          text: message.message?.trim() || 'Run interrupted.',
        }],
      }, { observedAt: this.now() }));
      this.transport.requestCompletionSnapshot();
      return;
    }

    if (message.type === 'pong') return;
    assertNever(message);
  }

  private sessionCommandUnavailable() {
    if (this.state.connection !== 'ready' || !this.transport.isConnected()) {
      return 'local-agent is not connected';
    }
    if (this.state.session.activeRun) {
      return 'wait for the current response to finish';
    }
    if (this.modelProfiles.hasPending()) {
      return 'a model command is already in progress';
    }
    if (this.runtimeConfig.hasPending()) {
      return 'runtime config is being updated';
    }
    return null;
  }

  private runtimeConfigUpdateUnavailable() {
    if (this.state.connection !== 'ready' || !this.transport.isConnected()) {
      return 'local-agent is not connected';
    }
    if (this.state.session.activeRun) {
      return 'wait for the current response to finish';
    }
    if (this.sessionCommands.hasPending()) {
      return 'a session command is in progress';
    }
    if (this.modelProfiles.hasPending()) {
      return 'a model command is in progress';
    }
    return null;
  }

  private reviewTransportReady() {
    return this.state.connection === 'ready' && this.transport.isConnected();
  }

  private modelCommandUnavailable() {
    if (this.state.connection !== 'ready' || !this.transport.isConnected()) {
      return 'local-agent is not connected';
    }
    if (this.state.session.sessionId === 'pending') {
      return 'wait for session synchronization';
    }
    if (this.state.session.activeRun) {
      return 'wait for the current response to finish';
    }
    if (this.sessionCommands.hasPending()) {
      return 'a session command is in progress';
    }
    if (this.modelProfiles.hasPending()) {
      return 'another model command is already in progress';
    }
    if (this.runtimeConfig.hasPending()) {
      return 'runtime config is being updated';
    }
    return null;
  }

  private updateSession(session: AgentSession) {
    if (session === this.state.session) return;
    this.state = { ...this.state, session };
    this.notify();
  }

  private setConnection(
    connection: TuiConnectionStatus,
    connectionDetail?: string,
  ) {
    if (
      this.state.connection === connection
      && this.state.connectionDetail === connectionDetail
    ) {
      return;
    }
    this.state = {
      ...this.state,
      connection,
      ...(connectionDetail ? { connectionDetail } : { connectionDetail: undefined }),
    };
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

function createPendingSession(): AgentSession {
  return {
    sessionId: 'pending',
    kind: 'chat',
    timeline: [],
    activeRun: null,
  };
}

function assertNever(value: never): never {
  throw new Error(`unhandled agent server message: ${String(value)}`);
}
