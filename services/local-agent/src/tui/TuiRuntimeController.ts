import { randomUUID } from 'node:crypto';
import { loadAgentContext } from '../contextLoader';
import type { LocalAgentServerMessage } from '../localAgentProtocol';
import { config } from '../config';
import { TUI_TEXT } from './render/text';
import { formatNow } from './render/terminalText';
import { TuiLocalServerClient } from './tuiLocalServerClient';
import { TuiLocalWebSocketClient } from './tuiLocalWebSocketClient';
import { buildTuiActionsFromServerMessage } from './tuiServerMessageActions';
import {
  selectFocusedActiveRun,
  selectFocusedBusy,
  selectFocusedPendingApproval,
} from './state/tuiStateReducer';
import type { TuiAction, TuiState } from './state/tuiState';
import type { ApprovalOption } from './types';

const LOCAL_SERVER_CONNECT_RETRIES = 5;
const LOCAL_SERVER_CONNECT_RETRY_DELAY_MS = 2000;
const LOCAL_SERVER_RECONNECT_RETRIES = 5;
const LOCAL_SERVER_RECONNECT_DELAY_MS = 2000;

type TuiRuntimeControllerOptions = {
  actorId: string;
  localServerPort: number;
  dispatch: (action: TuiAction) => void;
  getState: () => TuiState;
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

function makeHistoryMeta() {
  return {
    id: randomUUID(),
    timestamp: formatNow(),
  };
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
        message: TUI_TEXT.initializationFailed(message),
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
      userText: message,
      now,
      userCell: makeHistoryMeta(),
      statusMessage: TUI_TEXT.waitingForReply,
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
      userText: TUI_TEXT.studioUserMessage(userRequest),
      now,
      userCell: makeHistoryMeta(),
      statusMessage: TUI_TEXT.studioRunning,
    });
    this.wsClient.send({
      type: 'studio_request',
      requestId,
      userRequest,
      ...(conversationId ? { conversationId } : {}),
    });
    return true;
  }

  submitReviewResponse(option: ApprovalOption, inputValue = '') {
    const inputText = inputValue.trim();
    const decision = option.input?.kind === 'text' && inputText
      ? inputText
      : option.message.trim();
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

    if (option.input?.kind === 'text' && !inputText) {
      this.appendSystemMessage(TUI_TEXT.approvalRespondRequiresInput);
      return false;
    }

    const now = Date.now();
    this.options.setNow(now);
    this.options.dispatch({
      type: 'review.response.resume',
      requestId,
      message: decision,
      now,
      userCell: makeHistoryMeta(),
      statusMessage: TUI_TEXT.reviewSubmitting,
    });

    this.wsClient.send({
      type: 'human_review_response',
      requestId,
      message: decision,
      reviewId: option.reviewId,
      selectedOptionId: option.selectedOptionId,
      ...(option.input?.kind === 'text' ? { input: { [option.input.key]: inputText } } : {}),
    });
    return true;
  }

  requestInterrupt() {
    const activeRun = selectFocusedActiveRun(this.options.getState());
    if (!this.isCurrentBusy() || !this.wsClient.isConnected() || !activeRun) {
      return false;
    }

    this.wsClient.send({
      type: 'interrupt_request',
      requestId: activeRun.requestId,
    });
    this.options.dispatch({
      type: 'run.interrupting',
      requestId: activeRun.requestId,
      statusMessage: TUI_TEXT.interrupting,
    });
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
        statusMessage: TUI_TEXT.interruptRequestedStatus,
        history: [{
          ...makeHistoryMeta(),
          kind: 'system',
          text: TUI_TEXT.interruptRequestedLocalRelease,
        }],
      });
    }, 1800);
    return true;
  }

  startNewSession() {
    this.clearInterruptTimeout();
    this.options.dispatch({
      type: 'input.set',
      value: '',
    });
    this.options.dispatch({
      type: 'session.clear',
      statusMessage: TUI_TEXT.newSessionCreated,
    });

    if (this.wsClient.isConnected()) {
      this.wsClient.send({ type: 'new_session' });
    }
  }

  dismissReview(requestId: string) {
    this.options.dispatch({
      type: 'review.dismiss',
      requestId,
      statusMessage: TUI_TEXT.approvalClosed,
    });
    this.options.dispatch({
      type: 'input.set',
      value: '',
    });
  }

  appendSystemMessage(text: string) {
    this.options.dispatch({
      type: 'history.append',
      cell: {
        id: randomUUID(),
        kind: 'system',
        timestamp: formatNow(),
        text,
      },
    });
  }

  private setRuntimeFromHealth(payload: { model?: string; contextWindow?: number; cwd?: string }) {
    const model = payload.model ?? config.llmModel;
    const cwd = payload.cwd ?? config.workdir;

    if (!model && !cwd && !payload.contextWindow) {
      return;
    }

    this.options.dispatch({
      type: 'session.set_runtime',
      runtime: {
        ...(model ? { model } : {}),
        ...(payload.contextWindow !== undefined ? { contextWindow: payload.contextWindow } : {}),
        ...(cwd ? { cwd } : {}),
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
      message: TUI_TEXT.connectionConnecting,
    });

    const connected = await this.waitForLocalServer();
    if (this.disposed || !connected) return;

    await this.restoreHistory();
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
            message: TUI_TEXT.connectionDisconnected,
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
          message: retryText,
        });
        this.appendSystemMessage(retryText);
        await sleep(LOCAL_SERVER_CONNECT_RETRY_DELAY_MS);
      }
    }
    return false;
  }

  private async restoreHistory() {
    try {
      const restored = await this.localServerClient.readHistory();
      if (restored.length > 0) {
        this.options.dispatch({
          type: 'session.replace_history',
          history: restored,
        });
      }
    } catch {
      // history restore is best-effort
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
        message: TUI_TEXT.connectionReconnectFailed,
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
      message: retryText,
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

    await this.fetchLocalRuntime();

    this.connectWebSocket();
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
      message: TUI_TEXT.statusReady,
    });
  }

  private handleWebSocketClose() {
    if (this.disposed) return;
    this.options.dispatch({
      type: 'connection.set',
      status: 'disconnected',
      message: TUI_TEXT.connectionClosed,
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
        type: 'session.set_actor',
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
    const result = buildTuiActionsFromServerMessage(msg, {
      now: Date.now(),
      makeHistoryCell: makeHistoryMeta,
    });
    if (result.clearInterrupt) {
      this.clearInterruptTimeout();
    }
    for (const action of result.actions) {
      this.options.dispatch(action);
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
}
