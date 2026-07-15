import { randomUUID } from 'node:crypto';
import type { BuiltinGlobalReviewPolicyMode, ReviewOption, ReviewResponse } from '@pinpawo/pet-agent';
import { loadAgentContext } from '../contextLoader';
import type { LocalAgentServerMessage } from '../localAgentProtocol';
import { getConfig, setConfig } from '../config';
import { TUI_TEXT } from './render/text';
import { TuiLocalServerClient } from './tuiLocalServerClient';
import { TuiLocalWebSocketClient } from './tuiLocalWebSocketClient';
import { createTuiMessage } from './tuiMessage';
import { buildTuiActionsFromServerMessage } from './tuiServerMessageActions';
import {
  selectFocusedActiveRun,
  selectFocusedBusy,
  selectFocusedPendingApproval,
} from './state/tuiStateReducer';
import type { TuiAction, TuiSnapshotApplyReason, TuiState } from './state/tuiState';

const LOCAL_SERVER_CONNECT_RETRIES = 5;
const LOCAL_SERVER_CONNECT_RETRY_DELAY_MS = 2000;
const LOCAL_SERVER_RECONNECT_RETRIES = 5;
const LOCAL_SERVER_RECONNECT_DELAY_MS = 2000;
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

export class TuiRuntimeController {
  private disposed = false;
  private interruptTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private readonly localServerClient: TuiLocalServerClient;
  private readonly wsClient: TuiLocalWebSocketClient;

  constructor(private readonly options: TuiRuntimeControllerOptions) {
    this.localServerClient = new TuiLocalServerClient({
      port: options.localServerPort,
    });
    this.wsClient = new TuiLocalWebSocketClient({
      port: options.localServerPort,
      handlers: {
        onOpen: () => this.handleWebSocketOpen(),
        onServerMessage: (message) => this.handleServerMessage(message),
        onClose: () => this.handleWebSocketClose(),
        onError: (err) => this.handleWebSocketError(err),
      },
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
    this.clearInterruptTimeout();
    this.clearReconnectTimeout();
    this.wsClient.disconnect();
  }

  isConnected() {
    return this.wsClient.isConnected();
  }

  isBusy() {
    return this.isCurrentBusy();
  }

  sendChatRequest(message: string) {
    if (!this.wsClient.isConnected()) {
      this.appendSystemMessage(TUI_TEXT.disconnectedCannotSend);
      return false;
    }
    if (this.isCurrentBusy()) {
      this.appendSystemMessage(TUI_TEXT.busyCannotSend);
      return false;
    }

    const requestId = randomUUID();
    const now = Date.now();
    this.options.setNow(now);
    this.options.dispatch({
      type: 'run.start',
      requestId,
      kind: 'chat',
      message: createTuiMessage({
        role: 'user',
        text: message,
        requestId,
        source: 'local-input',
      }, now),
      now,
    });

    this.wsClient.send({
      type: 'chat_request',
      requestId,
      message,
    });
    return true;
  }

  sendStudioRequest(userRequest: string, conversationId: string | null) {
    if (!this.wsClient.isConnected()) {
      this.appendSystemMessage(TUI_TEXT.disconnectedCannotSend);
      return false;
    }
    if (this.isCurrentBusy()) {
      this.appendSystemMessage(TUI_TEXT.busyCannotSend);
      return false;
    }

    const requestId = randomUUID();
    const now = Date.now();
    this.options.setNow(now);
    this.options.dispatch({
      type: 'run.start',
      requestId,
      kind: 'studio',
      message: createTuiMessage({
        role: 'user',
        text: TUI_TEXT.studioUserMessage(userRequest),
        requestId,
        source: 'local-input',
      }, now),
      now,
    });
    this.wsClient.send({
      type: 'studio_request',
      requestId,
      userRequest,
      ...(conversationId ? { conversationId } : {}),
    });
    return true;
  }

  submitReviewResponse(option: ReviewOption, inputValue = '') {
    const inputText = inputValue.trim();
    const decision = option.input?.kind === 'text' && inputText
      ? inputText
      : option.label.trim();
    if (!decision) return false;

    if (!this.wsClient.isConnected()) {
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

    this.options.dispatch({
      type: 'review.action.submit',
      requestId,
      actionId: currentApproval.actionId,
      decision: response,
    });

    this.wsClient.send({
      type: 'human_review_response',
      requestId,
      actionId: currentApproval.actionId,
      reviewId,
      selectedOptionId: option.id,
      ...(option.input?.kind === 'text' ? { input: { [option.input.key]: inputText } } : {}),
      decisions,
    });
    return true;
  }

  requestInterrupt() {
    const activeRun = selectFocusedActiveRun(this.options.getState());
    if (!this.wsClient.isConnected() || !activeRun) {
      return false;
    }

    const waitingReviewAction = activeRun.reviewAction?.status === 'waiting'
      ? activeRun.reviewAction
      : null;
    if (waitingReviewAction) {
      this.wsClient.send({
        type: 'review.cancel',
        requestId: activeRun.requestId,
        actionId: waitingReviewAction.actionId,
      });
      this.options.dispatch({
        type: 'review.action.cancel',
        requestId: activeRun.requestId,
        actionId: waitingReviewAction.actionId,
      });
    } else {
      this.wsClient.send({
        type: 'run.interrupt',
        requestId: activeRun.requestId,
      });
      this.options.dispatch({
        type: 'run.interrupting',
        requestId: activeRun.requestId,
      });
    }
    this.clearInterruptTimeout();

    const interruptRequestId = activeRun.requestId;
    this.interruptTimeout = setTimeout(() => {
      const state = this.options.getState();
      const currentRun = selectFocusedActiveRun(state);
      if (!selectFocusedBusy(state) || currentRun?.requestId !== interruptRequestId) {
        return;
      }
      this.options.dispatch({
        type: 'run.finish',
        requestId: interruptRequestId,
        statusNotice: TUI_TEXT.interruptRequestedStatus,
        messages: [createTuiMessage({
          id: `message:${interruptRequestId}:interrupt-local-release`,
          role: 'system',
          text: TUI_TEXT.interruptRequestedLocalRelease,
          requestId: interruptRequestId,
          source: 'live-event',
        })],
      });
    }, 1800);
    return true;
  }

  startNewSession() {
    this.clearInterruptTimeout();
    this.options.resetTimelineView();
    this.options.dispatch({
      type: 'input.set',
      value: '',
    });
    this.options.dispatch({
      type: 'session.clear',
      statusNotice: TUI_TEXT.newSessionCreated,
    });

    if (this.wsClient.isConnected()) {
      this.wsClient.send({ type: 'new_session' });
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
        source: 'live-event',
      }),
    });
  }

  private setRuntimeFromHealth(payload: {
    model?: string;
    contextWindow?: number;
    cwd?: string;
    workspaceId?: string;
    workspaceName?: string;
    workspaceRoot?: string;
    stateRoot?: string;
    studioConfigPath?: string;
    studioDueRunsPath?: string;
    studioConfigSource?: string;
    studioConfigActivePath?: string;
    legacyStudioConfigPath?: string;
    petsDir?: string;
    studioWikiBaseDir?: string;
  }) {
    const config = getConfig();
    const model = payload.model ?? config.llmModel;
    const cwd = payload.cwd ?? this.options.workdir ?? config.workdir;

    if (!model && !cwd && !payload.contextWindow) {
      return;
    }

    this.options.dispatch({
      type: 'session.configured',
      runtime: {
        ...(model ? { model } : {}),
        ...(payload.contextWindow !== undefined ? { contextWindow: payload.contextWindow } : {}),
        ...(cwd ? { cwd } : {}),
        ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
        ...(payload.workspaceName ? { workspaceName: payload.workspaceName } : {}),
        ...(payload.workspaceRoot ? { workspaceRoot: payload.workspaceRoot } : {}),
        ...(payload.stateRoot ? { stateRoot: payload.stateRoot } : {}),
        ...(payload.studioConfigPath ? { studioConfigPath: payload.studioConfigPath } : {}),
        ...(payload.studioDueRunsPath ? { studioDueRunsPath: payload.studioDueRunsPath } : {}),
        ...(payload.studioConfigSource ? { studioConfigSource: payload.studioConfigSource } : {}),
        ...(payload.studioConfigActivePath ? { studioConfigActivePath: payload.studioConfigActivePath } : {}),
        ...(payload.legacyStudioConfigPath ? { legacyStudioConfigPath: payload.legacyStudioConfigPath } : {}),
        ...(payload.petsDir ? { petsDir: payload.petsDir } : {}),
        ...(payload.studioWikiBaseDir ? { studioWikiBaseDir: payload.studioWikiBaseDir } : {}),
      },
    });
  }

  private async fetchLocalRuntime() {
    const payload = await this.localServerClient.readRuntime();
    if (!payload) return false;
    this.setRuntimeFromHealth(payload);
    return true;
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

    this.connectWebSocket();
    await this.loadActorContext();
  }

  private async waitForLocalServer() {
    for (let attempt = 0; attempt <= LOCAL_SERVER_CONNECT_RETRIES; attempt += 1) {
      if (this.disposed) return false;
      try {
        const health = await this.checkLocalServerHealth();
        if (!health) throw new Error('health check failed');
        await this.fetchLocalRuntime();
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

  private connectWebSocket() {
    this.clearReconnectTimeout();
    this.wsClient.connect();
  }

  private async checkLocalServerHealth() {
    return this.localServerClient.isHealthy();
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimeout || this.wsClient.hasSocket()) return;

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
    if (this.disposed || this.wsClient.hasSocket()) return;

    const health = await this.checkLocalServerHealth();
    if (this.disposed || this.wsClient.hasSocket()) return;

    if (!health) {
      this.scheduleReconnect();
      return;
    }

    await this.applyLatestSessionSnapshot('reconnect');
    if (this.disposed || this.wsClient.hasSocket()) return;

    this.options.resetTimelineView();
    this.connectWebSocket();
  }

  private async refreshSnapshotAfterReviewError() {
    try {
      const restored = await this.applyLatestSessionSnapshot('review-refresh');
      if (restored && !this.disposed) {
        this.options.resetTimelineView();
      }
    } catch (err) {
      if (this.disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      this.appendSystemMessage(TUI_TEXT.reconnectFailed(message));
    }
  }

  private async refreshSnapshotAfterCompletedMessage() {
    const restored = await this.applyLatestSessionSnapshot('completion');
    if (restored && !this.disposed) {
      this.options.resetTimelineView();
    }
  }

  private handleWebSocketOpen() {
    if (this.disposed) {
      this.wsClient.disconnect();
      return;
    }
    this.reconnectAttempt = 0;
    this.options.dispatch({
      type: 'connection.set',
      status: 'ready',
    });
    this.sendRuntimeConfigUpdate();
  }

  private handleWebSocketClose() {
    if (this.disposed) return;
    this.options.dispatch({
      type: 'connection.set',
      status: 'disconnected',
      detail: TUI_TEXT.connectionClosed,
    });
    this.scheduleReconnect();
  }

  private handleWebSocketError(err: Error) {
    if (this.disposed) return;
    this.appendSystemMessage(TUI_TEXT.websocketError(err.message));
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
    const now = Date.now();
    const result = buildTuiActionsFromServerMessage(msg, {
      now,
      createMessage: (input) => createTuiMessage(input, now),
    });
    if (result.clearInterrupt) {
      this.clearInterruptTimeout();
    }
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

  private clearInterruptTimeout() {
    if (this.interruptTimeout) {
      clearTimeout(this.interruptTimeout);
      this.interruptTimeout = null;
    }
  }

  private clearReconnectTimeout() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private sendRuntimeConfigUpdate() {
    if (!this.wsClient.isConnected()) {
      return false;
    }
    return Boolean(this.wsClient.send({
      type: 'runtime_config.update',
      globalReviewPolicyMode: getConfig().globalReviewPolicyMode,
    }));
  }
}
