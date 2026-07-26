import { randomUUID } from 'node:crypto';
import type { BuiltinGlobalReviewPolicyMode, ReviewOption, ReviewResponse } from '@pinpawo/pet-agent';
import { loadAgentContext } from '../contextLoader';
import type { LocalAgentServerMessage } from '../localAgentProtocol';
import { getConfig, setConfig } from '../config';
import type {
  LocalAgentConnection,
  LocalAgentConnectionFactory,
} from './localAgentConnection';
import { TUI_TEXT } from './render/text';
import { TuiLocalServerClient } from './tuiLocalServerClient';
import { createTuiMessage } from './tuiMessage';
import { buildTuiActionsFromServerMessage } from './tuiServerMessageActions';
import {
  selectFocusedActiveRun,
  selectFocusedBusy,
  selectFocusedPendingApproval,
  selectFocusedReviewResolutionSent,
} from './state/tuiStateReducer';
import type { TuiAction, TuiSnapshotApplyReason, TuiState } from './state/tuiState';

const LOCAL_SERVER_CONNECT_RETRIES = 5;
const LOCAL_SERVER_CONNECT_RETRY_DELAY_MS = 2000;
const LOCAL_SERVER_RECONNECT_RETRIES = 5;
const LOCAL_SERVER_RECONNECT_DELAY_MS = 2000;
const INTERRUPT_PENDING_NOTICE_DELAY_MS = 10_000;
const REVIEW_SNAPSHOT_REFRESH_ERROR_CODES = new Set([
  'review_closed',
  'review_stale',
  'review_wrong_session',
]);

type TuiRuntimeControllerOptions = {
  actorId: string;
  localServerPort: number;
  workdir?: string;
  dispatch: (action: TuiAction) => void;
  getState: () => TuiState;
  resetTimelineView: () => void;
  setNow: (now: number) => void;
  connectionFactory: LocalAgentConnectionFactory;
};

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildPetSummary(context: Awaited<ReturnType<typeof loadAgentContext>>) {
  const pet = context.pet;
  const pieces = [pet.species || TUI_TEXT.unknownSpecies, pet.stage || TUI_TEXT.unknownStage];
  return pieces.join(' · ');
}

type RuntimeSnapshotApplyReason = Exclude<TuiSnapshotApplyReason, 'resume'>;
type RuntimeSnapshotRefreshReason = 'completion' | 'review-refresh';

function getSnapshotRefreshReason(
  message: LocalAgentServerMessage,
): RuntimeSnapshotRefreshReason | null {
  if (message.type !== 'event') return null;
  if (message.event.type === 'message.completed') return 'completion';
  if (
    message.event.type === 'error'
    && message.event.code
    && REVIEW_SNAPSHOT_REFRESH_ERROR_CODES.has(message.event.code)
  ) {
    return 'review-refresh';
  }
  return null;
}

function concludesInterruptWait(message: LocalAgentServerMessage) {
  if (
    message.type === 'interrupted'
    || message.type === 'studio_response'
    || message.type === 'studio_error'
  ) {
    return true;
  }
  return message.type === 'event' && (
    message.event.type === 'human_review.requested'
    || message.event.type === 'message.completed'
    || message.event.type === 'error'
  );
}

export class TuiRuntimeController {
  private disposed = false;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private interruptPendingNoticeTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private readonly localServerClient: TuiLocalServerClient;
  private readonly connection: LocalAgentConnection;

  constructor(private readonly options: TuiRuntimeControllerOptions) {
    this.localServerClient = new TuiLocalServerClient({
      port: options.localServerPort,
    });
    this.connection = options.connectionFactory({
      onOpen: () => this.handleConnectionOpen(),
      onMessage: (message) => this.handleServerMessage(message),
      onClose: () => this.handleConnectionClose(),
      onError: (err) => this.handleConnectionError(err),
    });
  }

  start() {
    this.disposed = false;
    void this.initialize().catch((err) => {
      if (this.disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      this.appendSystemMessage(TUI_TEXT.initializationFailed(message));
      this.options.dispatch({
        type: 'connection.set',
        status: 'error',
        detail: TUI_TEXT.initializationFailed(message),
      });
    });
  }

  dispose() {
    this.disposed = true;
    this.clearReconnectTimeout();
    this.clearInterruptPendingNoticeTimeout();
    this.connection.disconnect();
  }

  isConnected() {
    return this.connection.isConnected();
  }

  isBusy() {
    return this.isCurrentBusy();
  }

  sendChatRequest(message: string) {
    if (!this.connection.isConnected()) {
      this.appendSystemMessage(TUI_TEXT.disconnectedCannotSend);
      return false;
    }
    if (this.isCurrentBusy()) {
      this.appendSystemMessage(TUI_TEXT.busyCannotSend);
      return false;
    }

    const requestId = randomUUID();
    const now = Date.now();
    if (!this.connection.send({
      type: 'chat_request',
      requestId,
      message,
    })) {
      this.appendSystemMessage(TUI_TEXT.disconnectedCannotSend);
      return false;
    }
    this.options.setNow(now);
    this.options.dispatch({
      type: 'run.start',
      requestId,
      kind: 'chat',
      message: createTuiMessage({
        role: 'user',
        text: message,
        requestId,
      }, now),
      now,
    });

    return true;
  }

  sendStudioRequest(userRequest: string, conversationId: string | null) {
    if (!this.connection.isConnected()) {
      this.appendSystemMessage(TUI_TEXT.disconnectedCannotSend);
      return false;
    }
    if (this.isCurrentBusy()) {
      this.appendSystemMessage(TUI_TEXT.busyCannotSend);
      return false;
    }

    const requestId = randomUUID();
    const now = Date.now();
    if (!this.connection.send({
      type: 'studio_request',
      requestId,
      userRequest,
      ...(conversationId ? { conversationId } : {}),
    })) {
      this.appendSystemMessage(TUI_TEXT.disconnectedCannotSend);
      return false;
    }
    this.options.setNow(now);
    this.options.dispatch({
      type: 'run.start',
      requestId,
      kind: 'studio',
      message: createTuiMessage({
        role: 'user',
        text: TUI_TEXT.studioUserMessage(userRequest),
        requestId,
      }, now),
      now,
    });
    return true;
  }

  submitReviewResponse(option: ReviewOption, inputValue = '') {
    const inputText = inputValue.trim();
    const decision = option.input?.kind === 'text' && inputText
      ? inputText
      : option.label.trim();
    if (!decision) return false;

    if (!this.connection.isConnected()) {
      this.appendSystemMessage(TUI_TEXT.reviewDisconnectedCannotSubmit);
      return false;
    }

    const state = this.options.getState();
    const currentApproval = selectFocusedPendingApproval(state);
    if (!currentApproval) {
      this.appendSystemMessage(TUI_TEXT.approvalClosed);
      return false;
    }
    const requestId = currentApproval.requestId;
    const reviewId = currentApproval.review.id;
    const reviews = currentApproval.reviews;

    if (option.input?.kind === 'text' && !inputText) {
      this.appendSystemMessage(TUI_TEXT.approvalRespondRequiresInput);
      return false;
    }

    const response: ReviewResponse = {
      reviewId,
      selectedOptionId: option.id,
      ...(option.input?.kind === 'text' ? { input: { [option.input.key]: inputText } } : {}),
    };
    const decisions = [
      ...currentApproval.decisions,
      response,
    ];
    const shouldResume = option.decision.type !== 'approve' || decisions.length >= reviews.length;
    const now = Date.now();
    this.options.setNow(now);
    if (!shouldResume) {
      this.options.dispatch({
        type: 'review.draft.record',
        requestId,
        actionId: currentApproval.actionId,
        decision: response,
      });
      return true;
    }

    const sent = this.connection.send({
      type: 'human_review_response',
      requestId,
      actionId: currentApproval.actionId,
      reviewId,
      selectedOptionId: option.id,
      ...(option.input?.kind === 'text' ? { input: { [option.input.key]: inputText } } : {}),
      decisions,
    });
    if (!sent) {
      this.appendSystemMessage(TUI_TEXT.reviewDisconnectedCannotSubmit);
      return false;
    }
    this.options.dispatch({
      type: 'review.resolution.sent',
      requestId,
      actionId: currentApproval.actionId,
      decision: response,
    });
    return true;
  }

  requestInterrupt() {
    const state = this.options.getState();
    const activeRun = selectFocusedActiveRun(state);
    if (!this.connection.isConnected() || !activeRun) {
      return false;
    }
    const resolutionSent = selectFocusedReviewResolutionSent(state);
    const waitingReviewAction = activeRun.state === 'waiting_review' && !resolutionSent
      ? activeRun.reviewAction
      : null;
    if (waitingReviewAction) {
      const sent = this.connection.send({
        type: 'review.cancel',
        requestId: activeRun.requestId,
        actionId: waitingReviewAction.actionId,
      });
      if (!sent) {
        this.appendSystemMessage(TUI_TEXT.disconnectedCannotSend);
        return false;
      }
      this.options.dispatch({
        type: 'review.resolution.sent',
        requestId: activeRun.requestId,
        actionId: waitingReviewAction.actionId,
      });
    } else {
      if (!this.connection.send({
        type: 'run.interrupt',
        requestId: activeRun.requestId,
      })) {
        this.appendSystemMessage(TUI_TEXT.disconnectedCannotSend);
        return false;
      }
    }
    this.scheduleInterruptPendingNotice(activeRun.requestId);
    return true;
  }

  startNewSession() {
    this.clearInterruptPendingNoticeTimeout();
    this.options.dispatch({
      type: 'input.set',
      value: '',
    });
    this.options.dispatch({
      type: 'session.clear',
      statusNotice: TUI_TEXT.newSessionCreated,
    });
    this.options.resetTimelineView();

    if (this.connection.isConnected()) {
      this.connection.send({ type: 'new_session' });
    }
  }

  updateRuntimeConfig(params: { globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode }) {
    setConfig({ globalReviewPolicyMode: params.globalReviewPolicyMode });
    return this.sendRuntimeConfigUpdate();
  }

  appendSystemMessage(text: string) {
    this.options.dispatch({
      type: 'message.appended',
      message: createTuiMessage({
        role: 'system',
        text,
      }),
    });
  }

  async listResumeSessions() {
    return this.localServerClient.listResumeSessions();
  }

  async resumeSession(sessionId: string) {
    return this.localServerClient.resumeSession(sessionId);
  }

  private async initialize() {
    this.options.dispatch({
      type: 'connection.set',
      status: 'connecting',
    });

    const connected = await this.waitForLocalServer();
    if (this.disposed || !connected) return;

    await this.applyLatestSessionSnapshot('startup');
    if (this.disposed) return;

    this.connect();
    await this.loadActorContext();
  }

  private async waitForLocalServer() {
    for (let attempt = 0; attempt <= LOCAL_SERVER_CONNECT_RETRIES; attempt += 1) {
      if (this.disposed) return false;
      try {
        const health = await this.checkLocalServerHealth();
        if (!health) throw new Error('health check failed');
        return true;
      } catch {
        if (this.disposed) return false;
        if (attempt >= LOCAL_SERVER_CONNECT_RETRIES) {
          this.appendSystemMessage(
            TUI_TEXT.connectionUnavailable(this.options.localServerPort),
          );
          this.options.dispatch({
            type: 'connection.set',
            status: 'disconnected',
          });
          return false;
        }
        const retryIndex = attempt + 1;
        const retryText = TUI_TEXT.connectionRetrying(
          LOCAL_SERVER_CONNECT_RETRY_DELAY_MS / 1000,
          retryIndex,
          LOCAL_SERVER_CONNECT_RETRIES,
        );
        this.options.dispatch({
          type: 'connection.set',
          status: 'connecting',
          detail: retryText,
        });
        this.appendSystemMessage(retryText);
        await sleep(LOCAL_SERVER_CONNECT_RETRY_DELAY_MS);
      }
    }
    return false;
  }

  private async applyLatestSessionSnapshot(reason: RuntimeSnapshotApplyReason) {
    try {
      const snapshot = await this.localServerClient.readSessionSnapshot();
      if (reason === 'completion' && selectFocusedBusy(this.options.getState())) {
        return false;
      }
      this.options.dispatch({
        type: 'session.snapshot.loaded',
        reason,
        snapshot,
        now: Date.now(),
      });
      return true;
    } catch (err) {
      if (reason === 'reconnect' || reason === 'review-refresh') {
        throw err;
      }
      // Startup and post-completion refresh are best-effort.
      return false;
    }
  }

  private connect() {
    this.clearReconnectTimeout();
    this.connection.connect();
  }

  private async checkLocalServerHealth() {
    return this.localServerClient.isHealthy();
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimeout || this.connection.hasConnection()) return;

    if (this.reconnectAttempt >= LOCAL_SERVER_RECONNECT_RETRIES) {
      this.options.dispatch({
        type: 'connection.set',
        status: 'disconnected',
        detail: TUI_TEXT.connectionReconnectFailed,
      });
      return;
    }

    this.reconnectAttempt += 1;
    const attempt = this.reconnectAttempt;
    const retryText = TUI_TEXT.connectionReconnectRetrying(
      LOCAL_SERVER_RECONNECT_DELAY_MS / 1000,
      attempt,
      LOCAL_SERVER_RECONNECT_RETRIES,
    );
    this.options.dispatch({
      type: 'connection.set',
      status: 'connecting',
      detail: retryText,
    });

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      void this.reconnect().catch((err) => {
        if (this.disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        this.appendSystemMessage(TUI_TEXT.reconnectFailed(message));
        this.scheduleReconnect();
      });
    }, LOCAL_SERVER_RECONNECT_DELAY_MS);
  }

  private async reconnect() {
    if (this.disposed || this.connection.hasConnection()) return;

    const health = await this.checkLocalServerHealth();
    if (this.disposed || this.connection.hasConnection()) return;

    if (!health) {
      this.scheduleReconnect();
      return;
    }

    await this.applyLatestSessionSnapshot('reconnect');
    if (this.disposed || this.connection.hasConnection()) return;

    this.connect();
  }

  private async refreshSnapshotAfterReviewError() {
    try {
      await this.applyLatestSessionSnapshot('review-refresh');
    } catch (err) {
      if (this.disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      this.appendSystemMessage(TUI_TEXT.reconnectFailed(message));
    }
  }

  private async refreshSnapshotAfterCompletedMessage() {
    await this.applyLatestSessionSnapshot('completion');
  }

  private handleConnectionOpen() {
    if (this.disposed) {
      this.connection.disconnect();
      return;
    }
    this.reconnectAttempt = 0;
    this.options.dispatch({
      type: 'connection.set',
      status: 'ready',
    });
    this.sendRuntimeConfigUpdate();
  }

  private handleConnectionClose() {
    if (this.disposed) return;
    this.options.dispatch({
      type: 'connection.set',
      status: 'disconnected',
      detail: TUI_TEXT.connectionClosed,
    });
    this.scheduleReconnect();
  }

  private handleConnectionError(err: Error) {
    if (this.disposed) return;
    this.appendSystemMessage(TUI_TEXT.connectionError(err.message));
  }

  private async loadActorContext() {
    try {
      const context = await loadAgentContext(this.options.actorId);
      if (this.disposed) return;
      this.options.dispatch({
        type: 'session.configured',
        actor: {
          label: context.pet.name,
          summary: buildPetSummary(context),
        },
      });
    } catch {
      if (!this.disposed) {
        this.appendSystemMessage(TUI_TEXT.actorContextUnavailable);
      }
    }
  }

  private handleServerMessage(msg: LocalAgentServerMessage) {
    if (concludesInterruptWait(msg)) {
      this.clearInterruptPendingNoticeTimeout();
    }
    const now = Date.now();
    const result = buildTuiActionsFromServerMessage(msg, {
      now,
      createMessage: (input) => createTuiMessage(input, now),
    });
    for (const action of result.actions) {
      this.options.dispatch(action);
    }
    const refreshReason = getSnapshotRefreshReason(msg);
    if (refreshReason === 'review-refresh') {
      void this.refreshSnapshotAfterReviewError();
    }
    if (refreshReason === 'completion') {
      void this.refreshSnapshotAfterCompletedMessage();
    }
  }

  private isCurrentBusy() {
    return selectFocusedBusy(this.options.getState());
  }

  private clearReconnectTimeout() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private scheduleInterruptPendingNotice(requestId: string) {
    this.clearInterruptPendingNoticeTimeout();
    this.interruptPendingNoticeTimeout = setTimeout(() => {
      this.interruptPendingNoticeTimeout = null;
      if (this.disposed) return;
      const activeRun = selectFocusedActiveRun(this.options.getState());
      if (activeRun?.requestId !== requestId) return;
      this.appendSystemMessage(TUI_TEXT.interruptStillPending);
    }, INTERRUPT_PENDING_NOTICE_DELAY_MS);
  }

  private clearInterruptPendingNoticeTimeout() {
    if (this.interruptPendingNoticeTimeout) {
      clearTimeout(this.interruptPendingNoticeTimeout);
      this.interruptPendingNoticeTimeout = null;
    }
  }

  private sendRuntimeConfigUpdate() {
    if (!this.connection.isConnected()) {
      return false;
    }
    return this.connection.send({
      type: 'runtime_config.update',
      globalReviewPolicyMode: getConfig().globalReviewPolicyMode,
    });
  }
}
