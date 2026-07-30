import {
  applySessionSnapshot,
  reduceSession,
  type AgentServerMessage,
  type AgentLocalAttachment,
  type ChatRequestMessage,
  type AgentReviewAction,
  type AgentSession,
  type AgentSessionSnapshot,
  type AgentSessionSummary,
  type BuiltinGlobalReviewPolicyMode,
  type ReviewResponse,
} from '@pinpawo/agent-session';
import type {
  AgentHostConnection,
  AgentHostConnectionFactory,
} from '../client/localHostConnection';
import { formatAttachmentDisplayText } from '../attachments/attachmentModel';
import {
  studioCompletionMessages,
  studioErrorMessage,
  studioProgressMessage,
  studioUserMessage,
} from './studioProjection';
import { reconcileCompletionSnapshot } from './completionSnapshot';

export type TuiConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'reconnecting'
  | 'ready'
  | 'disconnected'
  | 'error';

export type TuiSessionState = {
  connection: TuiConnectionStatus;
  connectionDetail?: string;
  session: AgentSession;
};

export type SubmitChatResult =
  | { ok: true; requestId: string }
  | {
      ok: false;
      reason:
        | 'not-ready'
        | 'busy'
        | 'empty'
        | 'send-failed';
    };

export type InterruptRunResult =
  | { ok: true; requestId: string }
  | {
      ok: false;
      reason:
        | 'not-ready'
        | 'idle'
        | 'review-active'
        | 'already-interrupting'
        | 'send-failed';
    };

export type InterruptResolvedReviewResult =
  | { ok: true; requestId: string }
  | {
      ok: false;
      reason: 'not-ready' | 'closed' | 'stale' | 'send-failed';
    };

type SnapshotReason = 'startup' | 'reconnect' | 'completion';
type ActiveDelegationTransition = NonNullable<
  ChatRequestMessage['activeDelegationTransition']
>;

type TimerHandle = ReturnType<typeof setTimeout>;

export type ResumeSessionResult = {
  session: AgentSessionSummary;
  snapshot: AgentSessionSnapshot;
};

export type StartNewSessionResult = ResumeSessionResult;

export type SubmitReviewResponseResult =
  | {
      ok: true;
      status: 'advanced' | 'sent';
      decision: ReviewResponse;
      decisions: ReviewResponse[];
    }
  | {
      ok: false;
      reason:
        | 'not-ready'
        | 'closed'
        | 'stale'
        | 'input-required'
        | 'send-failed';
    };

export type CancelReviewResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not-ready' | 'closed' | 'stale' | 'send-failed';
    };

export type UpdateGlobalReviewPolicyResult = {
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
};

export type TuiSessionControllerOptions = {
  connectionFactory: AgentHostConnectionFactory;
  now?: () => number;
  requestIdFactory?: () => string;
  reconnectDelaysMs?: readonly number[];
  snapshotTimeoutMs?: number;
  sessionCommandTimeoutMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};

const DEFAULT_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 5_000;
const DEFAULT_SESSION_COMMAND_TIMEOUT_MS = 5_000;

type PendingSessionCommand =
  | {
      operation: 'list';
      requestId: string;
      timer: TimerHandle | null;
      resolve: (sessions: AgentSessionSummary[]) => void;
      reject: (error: Error) => void;
    }
  | {
      operation: 'new';
      requestId: string;
      timer: TimerHandle | null;
      resolve: (result: StartNewSessionResult) => void;
      reject: (error: Error) => void;
    }
  | {
      operation: 'resume';
      requestId: string;
      sessionId: string;
      timer: TimerHandle | null;
      resolve: (result: ResumeSessionResult) => void;
      reject: (error: Error) => void;
    };

type PendingRuntimeConfigUpdate = {
  requestId: string;
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
  timer: TimerHandle | null;
  resolve: (result: UpdateGlobalReviewPolicyResult) => void;
  reject: (error: Error) => void;
};

export class TuiSessionController {
  private readonly now: () => number;
  private readonly requestIdFactory: () => string;
  private readonly reconnectDelaysMs: readonly number[];
  private readonly snapshotTimeoutMs: number;
  private readonly sessionCommandTimeoutMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly connection: AgentHostConnection;
  private readonly listeners = new Set<(state: TuiSessionState) => void>();
  private readonly snapshotRequests = new Map<string, SnapshotReason>();
  private readonly sessionCommands = new Map<string, PendingSessionCommand>();
  private runtimeConfigUpdate: PendingRuntimeConfigUpdate | null = null;
  private state: TuiSessionState = {
    connection: 'idle',
    session: createPendingSession(),
  };
  private started = false;
  private reconnectAttempt = 0;
  private reconnectTimer: TimerHandle | null = null;
  private snapshotTimer: TimerHandle | null = null;

  constructor(options: TuiSessionControllerOptions) {
    this.now = options.now ?? Date.now;
    this.requestIdFactory = options.requestIdFactory ?? (() => crypto.randomUUID());
    this.reconnectDelaysMs = options.reconnectDelaysMs?.length
      ? options.reconnectDelaysMs
      : DEFAULT_RECONNECT_DELAYS_MS;
    this.snapshotTimeoutMs = options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
    this.sessionCommandTimeoutMs = options.sessionCommandTimeoutMs
      ?? DEFAULT_SESSION_COMMAND_TIMEOUT_MS;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.connection = options.connectionFactory({
      onOpen: () => this.handleOpen(),
      onMessage: (message) => this.handleMessage(message),
      onClose: () => this.handleClose(),
      onError: (error) => this.handleError(error),
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
    if (this.started) return;
    this.started = true;
    this.reconnectAttempt = 0;
    this.setConnection('connecting', 'connecting to local-agent');
    this.connection.connect();
  }

  stop() {
    this.started = false;
    this.clearReconnectTimer();
    this.clearSnapshotTimer();
    this.snapshotRequests.clear();
    this.rejectSessionCommands('session command cancelled');
    this.rejectRuntimeConfigUpdate('runtime config update cancelled');
    this.connection.disconnect();
    this.setConnection('idle');
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

  private submitChatWithTransition(
    message: string,
    attachments: readonly AgentLocalAttachment[],
    activeDelegationTransition?: ActiveDelegationTransition,
  ): SubmitChatResult {
    if (!message.trim() && attachments.length === 0) {
      return { ok: false, reason: 'empty' };
    }
    if (this.state.connection !== 'ready' || !this.connection.isConnected()) {
      return { ok: false, reason: 'not-ready' };
    }
    if (
      this.state.session.activeRun
      || this.sessionCommands.size > 0
      || this.runtimeConfigUpdate
    ) {
      return { ok: false, reason: 'busy' };
    }

    const requestId = this.requestIdFactory();
    if (!this.connection.send({
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
    if (this.state.connection !== 'ready' || !this.connection.isConnected()) {
      return { ok: false, reason: 'not-ready' };
    }
    if (
      this.state.session.activeRun
      || this.sessionCommands.size > 0
      || this.runtimeConfigUpdate
    ) {
      return { ok: false, reason: 'busy' };
    }

    const requestId = this.requestIdFactory();
    if (!this.connection.send({
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
    if (this.state.connection !== 'ready' || !this.connection.isConnected()) {
      return { ok: false, reason: 'not-ready' };
    }
    const run = this.state.session.activeRun;
    if (!run) {
      return { ok: false, reason: 'idle' };
    }
    if (run.state === 'waiting_review') {
      return { ok: false, reason: 'review-active' };
    }
    if (run.state === 'interrupting') {
      return { ok: false, reason: 'already-interrupting' };
    }
    if (!this.connection.send({
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
    requestId: string;
    actionId: string;
  }): InterruptResolvedReviewResult {
    if (this.state.connection !== 'ready' || !this.connection.isConnected()) {
      return { ok: false, reason: 'not-ready' };
    }
    const run = this.state.session.activeRun;
    if (!run || run.state !== 'waiting_review') {
      return { ok: false, reason: 'closed' };
    }
    if (
      run.requestId !== params.requestId
      || run.reviewAction.actionId !== params.actionId
    ) {
      return { ok: false, reason: 'stale' };
    }
    if (!this.connection.send({
      type: 'run.interrupt',
      requestId: run.requestId,
    })) {
      return { ok: false, reason: 'send-failed' };
    }
    return { ok: true, requestId: run.requestId };
  }

  startNewSession(): Promise<StartNewSessionResult> {
    const unavailable = this.sessionCommandUnavailable();
    if (unavailable) return Promise.reject(new Error(unavailable));

    const requestId = this.requestIdFactory();
    return new Promise((resolve, reject) => {
      const pending: PendingSessionCommand = {
        operation: 'new',
        requestId,
        timer: null,
        resolve,
        reject,
      };
      this.sessionCommands.set(requestId, pending);
      pending.timer = this.scheduleSessionCommandTimeout(pending);
      if (!this.connection.send({ type: 'session.new', requestId })) {
        this.clearSessionCommand(pending);
        reject(new Error('session new request could not be sent'));
      }
    });
  }

  listSessions(): Promise<AgentSessionSummary[]> {
    const unavailable = this.sessionCommandUnavailable();
    if (unavailable) return Promise.reject(new Error(unavailable));

    const requestId = this.requestIdFactory();
    return new Promise((resolve, reject) => {
      const pending: PendingSessionCommand = {
        operation: 'list',
        requestId,
        timer: null,
        resolve,
        reject,
      };
      this.sessionCommands.set(requestId, pending);
      pending.timer = this.scheduleSessionCommandTimeout(pending);
      if (!this.connection.send({ type: 'session.list', requestId })) {
        this.clearSessionCommand(pending);
        reject(new Error('session list request could not be sent'));
      }
    });
  }

  resumeSession(sessionId: string): Promise<ResumeSessionResult> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return Promise.reject(new Error('session id is required'));
    }
    const unavailable = this.sessionCommandUnavailable();
    if (unavailable) return Promise.reject(new Error(unavailable));

    const requestId = this.requestIdFactory();
    return new Promise((resolve, reject) => {
      const pending: PendingSessionCommand = {
        operation: 'resume',
        requestId,
        sessionId: normalizedSessionId,
        timer: null,
        resolve,
        reject,
      };
      this.sessionCommands.set(requestId, pending);
      pending.timer = this.scheduleSessionCommandTimeout(pending);
      if (!this.connection.send({
        type: 'session.resume',
        requestId,
        sessionId: normalizedSessionId,
      })) {
        this.clearSessionCommand(pending);
        reject(new Error('session resume request could not be sent'));
      }
    });
  }

  updateGlobalReviewPolicy(
    globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode,
  ): Promise<UpdateGlobalReviewPolicyResult> {
    const unavailable = this.runtimeConfigUpdateUnavailable();
    if (unavailable) return Promise.reject(new Error(unavailable));

    const requestId = this.requestIdFactory();
    return new Promise((resolve, reject) => {
      const pending: PendingRuntimeConfigUpdate = {
        requestId,
        globalReviewPolicyMode,
        timer: null,
        resolve,
        reject,
      };
      this.runtimeConfigUpdate = pending;
      pending.timer = this.setTimer(() => {
        if (this.runtimeConfigUpdate !== pending) return;
        this.runtimeConfigUpdate = null;
        pending.timer = null;
        pending.reject(new Error('runtime config update timed out'));
      }, this.sessionCommandTimeoutMs);
      if (!this.connection.send({
        type: 'runtime_config.update',
        requestId,
        globalReviewPolicyMode,
      })) {
        this.clearRuntimeConfigUpdate(pending);
        reject(new Error('runtime config update could not be sent'));
      }
    });
  }

  submitReviewResponse(params: {
    requestId: string;
    actionId: string;
    decisions: readonly ReviewResponse[];
    optionId: string;
    inputText?: string;
  }): SubmitReviewResponseResult {
    if (!this.reviewTransportReady()) {
      return { ok: false, reason: 'not-ready' };
    }
    const run = this.state.session.activeRun;
    if (!run || run.state !== 'waiting_review') {
      return { ok: false, reason: 'closed' };
    }
    if (
      run.requestId !== params.requestId
      || run.reviewAction.actionId !== params.actionId
    ) {
      return { ok: false, reason: 'stale' };
    }
    if (!reviewDecisionsMatch(run.reviewAction, params.decisions)) {
      return { ok: false, reason: 'stale' };
    }

    const review = run.reviewAction.reviews[params.decisions.length];
    const option = review?.options.find((candidate) => candidate.id === params.optionId);
    if (!review || !option) {
      return { ok: false, reason: 'stale' };
    }
    const inputText = params.inputText?.trim() ?? '';
    if (option.input?.kind === 'text' && !inputText) {
      return { ok: false, reason: 'input-required' };
    }
    const input = option.input?.kind === 'text'
      ? { [option.input.key]: inputText }
      : undefined;
    const decision: ReviewResponse = {
      reviewId: review.id,
      selectedOptionId: option.id,
      ...(input ? { input } : {}),
    };
    const decisions = [...params.decisions, decision];
    const shouldSend = option.decision.type !== 'approve'
      || decisions.length >= run.reviewAction.reviews.length;
    if (!shouldSend) {
      return {
        ok: true,
        status: 'advanced',
        decision,
        decisions,
      };
    }
    if (!this.connection.send({
      type: 'human_review_response',
      requestId: run.requestId,
      actionId: run.reviewAction.actionId,
      reviewId: review.id,
      selectedOptionId: option.id,
      ...(input ? { input } : {}),
      decisions,
    })) {
      return { ok: false, reason: 'send-failed' };
    }
    return {
      ok: true,
      status: 'sent',
      decision,
      decisions,
    };
  }

  cancelReview(params: {
    requestId: string;
    actionId: string;
  }): CancelReviewResult {
    if (!this.reviewTransportReady()) {
      return { ok: false, reason: 'not-ready' };
    }
    const run = this.state.session.activeRun;
    if (!run || run.state !== 'waiting_review') {
      return { ok: false, reason: 'closed' };
    }
    if (
      run.requestId !== params.requestId
      || run.reviewAction.actionId !== params.actionId
    ) {
      return { ok: false, reason: 'stale' };
    }
    if (!this.connection.send({
      type: 'review.cancel',
      requestId: run.requestId,
      actionId: run.reviewAction.actionId,
    })) {
      return { ok: false, reason: 'send-failed' };
    }
    return { ok: true };
  }

  private handleOpen() {
    if (!this.started) {
      this.connection.disconnect();
      return;
    }
    const reason: SnapshotReason = this.reconnectAttempt > 0 ? 'reconnect' : 'startup';
    this.setConnection(
      reason === 'reconnect' ? 'reconnecting' : 'connecting',
      'synchronizing session',
    );
    this.requestSnapshot(reason);
  }

  private handleMessage(message: AgentServerMessage) {
    if (
      message.type === 'runtime_config.result'
      || message.type === 'runtime_config.error'
    ) {
      const pending = this.runtimeConfigUpdate;
      if (!pending || pending.requestId !== message.requestId) return;
      this.clearRuntimeConfigUpdate(pending);
      if (message.type === 'runtime_config.error') {
        pending.reject(new Error(message.message));
        return;
      }
      if (message.globalReviewPolicyMode !== pending.globalReviewPolicyMode) {
        pending.reject(new Error('runtime config response did not match the requested policy'));
        return;
      }
      this.updateSession({
        ...this.state.session,
        runtime: {
          ...this.state.session.runtime,
          globalReviewPolicyMode: message.globalReviewPolicyMode,
        },
      });
      pending.resolve({
        globalReviewPolicyMode: message.globalReviewPolicyMode,
      });
      return;
    }

    if (message.type === 'session.list.result') {
      const pending = this.sessionCommands.get(message.requestId);
      if (pending?.operation !== 'list') return;
      this.clearSessionCommand(pending);
      pending.resolve(message.sessions);
      return;
    }

    if (message.type === 'session.new.result') {
      const pending = this.sessionCommands.get(message.requestId);
      if (pending?.operation !== 'new') return;
      this.clearSessionCommand(pending);
      this.clearSnapshotTimer();
      this.snapshotRequests.clear();
      this.updateSession(applySessionSnapshot(
        this.state.session,
        message.snapshot,
        { observedAt: this.now() },
      ));
      pending.resolve({
        session: message.session,
        snapshot: message.snapshot,
      });
      return;
    }

    if (message.type === 'session.resume.result') {
      const pending = this.sessionCommands.get(message.requestId);
      if (pending?.operation !== 'resume') return;
      if (
        pending.sessionId !== message.session.id
        || pending.sessionId !== message.snapshot.session.sessionId
      ) {
        this.clearSessionCommand(pending);
        pending.reject(new Error(
          'session resume response did not match the requested session',
        ));
        return;
      }
      this.clearSessionCommand(pending);
      this.clearSnapshotTimer();
      this.snapshotRequests.clear();
      this.updateSession(applySessionSnapshot(
        this.state.session,
        message.snapshot,
        { observedAt: this.now() },
      ));
      pending.resolve({
        session: message.session,
        snapshot: message.snapshot,
      });
      return;
    }

    if (message.type === 'session.snapshot.result') {
      const reason = this.snapshotRequests.get(message.requestId);
      if (!reason) return;
      this.snapshotRequests.delete(message.requestId);
      if (reason !== 'completion') {
        this.clearSnapshotTimer();
      }
      const session = reason === 'completion'
        ? reconcileCompletionSnapshot(
          this.state.session,
          message.snapshot,
          this.now(),
        )
        : applySessionSnapshot(this.state.session, message.snapshot, {
          observedAt: this.now(),
          preserveOmittedTokenUsage: reason !== 'startup',
          preserveOmittedSessionTokenUsage: reason !== 'startup',
        });
      if (reason === 'startup' || reason === 'reconnect') {
        this.reconnectAttempt = 0;
        this.state = {
          connection: 'ready',
          session,
        };
        this.notify();
      } else {
        this.updateSession(session);
      }
      return;
    }

    if (message.type === 'session.error') {
      const command = this.sessionCommands.get(message.requestId);
      if (command?.operation === message.operation) {
        this.clearSessionCommand(command);
        command.reject(new Error(message.message));
        return;
      }
      const reason = this.snapshotRequests.get(message.requestId);
      if (reason) {
        this.snapshotRequests.delete(message.requestId);
        if (reason !== 'completion') {
          this.clearSnapshotTimer();
          this.setConnection('error', message.message);
        } else {
          this.setConnection('ready', `snapshot refresh failed: ${message.message}`);
        }
      }
      return;
    }

    if (message.type === 'event') {
      const projectedMessage = (
        message.event.type === 'studio.progress'
        && this.state.session.activeRun?.requestId === message.event.requestId
      )
        ? studioProgressMessage(message.event)
        : null;
      this.updateSession(reduceSession(this.state.session, {
        type: 'runtime.event',
        event: message.event,
        ...(projectedMessage ? { message: projectedMessage } : {}),
      }, { observedAt: this.now() }));
      if (
        message.event.type === 'message.completed'
        || message.event.type === 'error'
      ) {
        this.requestSnapshot('completion');
      }
      return;
    }

    if (message.type === 'studio_response') {
      this.updateSession(reduceSession(this.state.session, {
        type: 'run.finished',
        requestId: message.requestId,
        messages: studioCompletionMessages(message),
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
      this.requestSnapshot('completion');
      return;
    }

    if (message.type === 'pong') return;
    assertNever(message);
  }

  private handleClose() {
    if (!this.started) return;
    this.clearSnapshotTimer();
    this.snapshotRequests.clear();
    this.rejectSessionCommands('local-agent disconnected');
    this.rejectRuntimeConfigUpdate('local-agent disconnected');
    this.scheduleReconnect();
  }

  private handleError(error: Error) {
    if (!this.started) return;
    this.setConnection('error', error.message);
  }

  private requestSnapshot(reason: SnapshotReason) {
    if (!this.connection.isConnected()) {
      if (reason !== 'completion') {
        this.scheduleReconnect();
      }
      return;
    }
    const requestId = this.requestIdFactory();
    this.snapshotRequests.set(requestId, reason);
    if (!this.connection.send({ type: 'session.snapshot.get', requestId })) {
      this.snapshotRequests.delete(requestId);
      if (reason !== 'completion') {
        this.scheduleReconnect();
      }
      return;
    }
    if (reason !== 'completion') {
      this.clearSnapshotTimer();
      this.snapshotTimer = this.setTimer(() => {
        this.snapshotTimer = null;
        if (!this.started || !this.snapshotRequests.has(requestId)) return;
        this.snapshotRequests.delete(requestId);
        this.connection.disconnect();
        this.setConnection('reconnecting', 'session synchronization timed out');
        this.scheduleReconnect();
      }, this.snapshotTimeoutMs);
    }
  }

  private scheduleReconnect() {
    if (!this.started || this.reconnectTimer) return;
    const delayIndex = Math.min(
      this.reconnectAttempt,
      this.reconnectDelaysMs.length - 1,
    );
    const delay = this.reconnectDelaysMs[delayIndex]!;
    this.reconnectAttempt += 1;
    const attemptDetail = this.reconnectAttempt <= this.reconnectDelaysMs.length
      ? `${this.reconnectAttempt}/${this.reconnectDelaysMs.length}`
      : `background attempt ${this.reconnectAttempt}`;
    this.setConnection(
      'reconnecting',
      `retrying in ${formatDelay(delay)} (${attemptDetail})`,
    );
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (this.started) {
        this.connection.connect();
      }
    }, delay);
  }

  private sessionCommandUnavailable() {
    if (this.state.connection !== 'ready' || !this.connection.isConnected()) {
      return 'local-agent is not connected';
    }
    if (this.state.session.activeRun) {
      return 'wait for the current response to finish';
    }
    if (this.sessionCommands.size > 0) {
      return 'another session command is already in progress';
    }
    if (this.runtimeConfigUpdate) {
      return 'runtime config is being updated';
    }
    return null;
  }

  private runtimeConfigUpdateUnavailable() {
    if (this.state.connection !== 'ready' || !this.connection.isConnected()) {
      return 'local-agent is not connected';
    }
    if (this.state.session.activeRun) {
      return 'wait for the current response to finish';
    }
    if (this.sessionCommands.size > 0) {
      return 'a session command is in progress';
    }
    if (this.runtimeConfigUpdate) {
      return 'runtime config is already being updated';
    }
    return null;
  }

  private reviewTransportReady() {
    return this.state.connection === 'ready' && this.connection.isConnected();
  }

  private scheduleSessionCommandTimeout(command: PendingSessionCommand) {
    return this.setTimer(() => {
      if (this.sessionCommands.get(command.requestId) !== command) return;
      this.sessionCommands.delete(command.requestId);
      command.timer = null;
      command.reject(new Error(`session ${command.operation} request timed out`));
    }, this.sessionCommandTimeoutMs);
  }

  private clearSessionCommand(command: PendingSessionCommand) {
    if (command.timer) {
      this.clearTimer(command.timer);
      command.timer = null;
    }
    this.sessionCommands.delete(command.requestId);
  }

  private rejectSessionCommands(message: string) {
    for (const command of [...this.sessionCommands.values()]) {
      this.clearSessionCommand(command);
      command.reject(new Error(message));
    }
  }

  private clearRuntimeConfigUpdate(update: PendingRuntimeConfigUpdate) {
    if (update.timer) {
      this.clearTimer(update.timer);
      update.timer = null;
    }
    if (this.runtimeConfigUpdate === update) {
      this.runtimeConfigUpdate = null;
    }
  }

  private rejectRuntimeConfigUpdate(message: string) {
    const update = this.runtimeConfigUpdate;
    if (!update) return;
    this.clearRuntimeConfigUpdate(update);
    update.reject(new Error(message));
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

  private clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearSnapshotTimer() {
    if (!this.snapshotTimer) return;
    this.clearTimer(this.snapshotTimer);
    this.snapshotTimer = null;
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

function formatDelay(delayMs: number) {
  return delayMs < 1_000
    ? `${delayMs}ms`
    : `${Math.round(delayMs / 100) / 10}s`;
}

function assertNever(value: never): never {
  throw new Error(`unhandled agent server message: ${String(value)}`);
}

function reviewDecisionsMatch(
  action: AgentReviewAction,
  decisions: readonly ReviewResponse[],
) {
  if (decisions.length >= action.reviews.length) return false;
  return decisions.every((decision, index) => {
    const review = action.reviews[index];
    const option = review?.options.find((candidate) => (
      candidate.id === decision.selectedOptionId
    ));
    return review?.id === decision.reviewId
      && option?.decision.type === 'approve';
  });
}
