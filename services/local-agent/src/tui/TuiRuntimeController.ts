import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { loadAgentContext } from '../contextLoader';
import { parseLocalAgentServerMessage, sendLocalAgentMessage } from '../localAgentProtocol';
import { TUI_TEXT } from './render/text';
import { formatNow } from './render/terminalText';
import {
  selectFocusedActiveRun,
  selectFocusedBusy,
  selectFocusedPendingApproval,
} from './state/tuiStateReducer';
import type { HistoryCellModel, TuiAction, TuiState } from './state/tuiState';
import type { ApprovalOption, ResumeSessionSummary } from './types';

const LOCAL_SERVER_CONNECT_RETRIES = 5;
const LOCAL_SERVER_CONNECT_RETRY_DELAY_MS = 2000;
const LOCAL_SERVER_HEALTH_TIMEOUT_MS = 1500;
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

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
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

function parseHistoryMessages(messages: Array<{ role?: string; text?: string }> | undefined) {
  return Array.isArray(messages)
    ? messages.flatMap((item) => {
      if (
        (item.role === 'user' || item.role === 'assistant' || item.role === 'system')
        && typeof item.text === 'string'
        && item.text.trim()
      ) {
        return [{
          id: randomUUID(),
          kind: item.role,
          text: item.text,
        } satisfies HistoryCellModel];
      }
      return [];
    })
    : [];
}

function parseResumeSessionSummary(value: unknown): ResumeSessionSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string'
    || typeof record.title !== 'string'
    || typeof record.createdAt !== 'string'
    || typeof record.updatedAt !== 'string'
  ) {
    return null;
  }
  return {
    id: record.id,
    title: record.title,
    messageCount: typeof record.messageCount === 'number' ? record.messageCount : 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    active: record.active === true,
  };
}

export class TuiRuntimeController {
  private ws: WebSocket | null = null;
  private disposed = false;
  private interruptTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  constructor(private readonly options: TuiRuntimeControllerOptions) {}

  start() {
    this.disposed = false;
    void this.initialize().catch((err) => {
      if (this.disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      this.appendSystemMessage(`初始化失败: ${message}`);
      this.options.dispatch({
        type: 'connection.set',
        status: 'error',
        message: `初始化失败: ${message}`,
      });
    });
  }

  dispose() {
    this.disposed = true;
    this.clearInterruptTimeout();
    this.clearReconnectTimeout();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected() {
    return Boolean(this.getOpenWebSocket());
  }

  isBusy() {
    return this.isCurrentBusy();
  }

  sendChatRequest(message: string) {
    const ws = this.getOpenWebSocket();
    if (!ws) {
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
      statusMessage: '等待回复',
    });

    sendLocalAgentMessage(ws, {
      type: 'chat_request',
      requestId,
      message,
    });
    return true;
  }

  sendStudioRequest(userRequest: string, conversationId: string | null) {
    const ws = this.getOpenWebSocket();
    if (!ws) {
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
      userText: `[studio] ${userRequest}`,
      now,
      userCell: makeHistoryMeta(),
      statusMessage: 'Studio 编排中',
    });
    sendLocalAgentMessage(ws, {
      type: 'studio_request',
      requestId,
      userRequest,
      ...(conversationId ? { conversationId } : {}),
    });
    return true;
  }

  submitReviewResponse(option: ApprovalOption) {
    const decision = option.message.trim();
    if (!decision) return false;

    const ws = this.getOpenWebSocket();
    if (!ws) {
      this.appendSystemMessage('未连接，无法提交确认。');
      return false;
    }

    const currentApproval = selectFocusedPendingApproval(this.options.getState());
    const requestId = currentApproval?.requestId ?? randomUUID();
    const now = Date.now();
    this.options.setNow(now);
    this.options.dispatch({
      type: 'review.response.start',
      requestId,
      message: decision,
      now,
      userCell: makeHistoryMeta(),
      statusMessage: '提交确认',
    });
    sendLocalAgentMessage(ws, {
      type: 'human_review_response',
      requestId,
      message: decision,
      ...(option.resume !== undefined ? { resume: option.resume } : {}),
    });
    return true;
  }

  requestInterrupt() {
    const ws = this.getOpenWebSocket();
    const activeRun = selectFocusedActiveRun(this.options.getState());
    if (!this.isCurrentBusy() || !ws || !activeRun) {
      return false;
    }

    sendLocalAgentMessage(ws, {
      type: 'interrupt_request',
      requestId: activeRun.requestId,
    });
    this.options.dispatch({
      type: 'run.interrupting',
      requestId: activeRun.requestId,
      statusMessage: '正在打断',
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
        statusMessage: '已请求打断',
        history: [{
          ...makeHistoryMeta(),
          kind: 'system',
          text: '打断请求已发送，本地先释放输入；迟到的旧响应会被忽略。',
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
      statusMessage: '已创建新会话',
    });

    const ws = this.getOpenWebSocket();
    if (ws) {
      sendLocalAgentMessage(ws, { type: 'new_session' });
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

  async listResumeSessions() {
    const res = await fetch(`http://127.0.0.1:${this.options.localServerPort}/sessions`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const payload = await res.json() as { sessions?: unknown };
    return Array.isArray(payload.sessions)
      ? payload.sessions.flatMap((item) => {
          const session = parseResumeSessionSummary(item);
          return session ? [session] : [];
        })
      : [];
  }

  async resumeSession(sessionId: string) {
    const res = await fetch(
      `http://127.0.0.1:${this.options.localServerPort}/sessions/resume?sessionId=${encodeURIComponent(sessionId)}`,
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const payload = await res.json() as {
      session?: unknown;
      messages?: Array<{ role?: string; text?: string }>;
    };
    const session = parseResumeSessionSummary(payload.session);
    if (!session) {
      throw new Error('invalid resume session payload');
    }
    const history = parseHistoryMessages(payload.messages);
    return { session, history };
  }

  private async initialize() {
    this.options.dispatch({
      type: 'connection.set',
      status: 'connecting',
      message: '连接本地服务',
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
        const healthy = await this.checkLocalServerHealth();
        if (!healthy) throw new Error('health check failed');
        return true;
      } catch {
        if (this.disposed) return false;
        if (attempt >= LOCAL_SERVER_CONNECT_RETRIES) {
          this.appendSystemMessage(
            `无法连接本地服务 (port ${this.options.localServerPort})，请先运行 pinpawo-agent run`,
          );
          this.options.dispatch({
            type: 'connection.set',
            status: 'disconnected',
            message: '未连接',
          });
          return false;
        }
        const retryIndex = attempt + 1;
        const retryText = `本地服务暂不可用，${LOCAL_SERVER_CONNECT_RETRY_DELAY_MS / 1000}s 后重试 ${retryIndex}/${LOCAL_SERVER_CONNECT_RETRIES}`;
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
      const historyRes = await fetch(`http://127.0.0.1:${this.options.localServerPort}/history`);
      if (!historyRes.ok) return;
      const payload = await historyRes.json() as {
        messages?: Array<{ role?: string; text?: string }>;
      };
      const restored = parseHistoryMessages(payload.messages);
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
    const ws = new WebSocket(`ws://127.0.0.1:${this.options.localServerPort}`);
    this.ws = ws;

    ws.on('open', () => {
      if (this.disposed) {
        ws.close();
        return;
      }
      if (this.ws !== ws) return;
      this.reconnectAttempt = 0;
      this.options.dispatch({
        type: 'connection.set',
        status: 'ready',
        message: TUI_TEXT.statusReady,
      });
    });

    ws.on('message', (data) => {
      if (this.ws !== ws) return;
      this.handleWsMessage(data);
    });

    ws.on('close', () => {
      if (this.disposed) return;
      if (this.ws !== ws) return;
      this.options.dispatch({
        type: 'connection.set',
        status: 'disconnected',
        message: '连接断开',
      });
      this.ws = null;
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (this.disposed) return;
      if (this.ws !== ws) return;
      this.appendSystemMessage(`WS error: ${err.message}`);
    });
  }

  private async checkLocalServerHealth() {
    try {
      const healthRes = await fetchWithTimeout(
        `http://127.0.0.1:${this.options.localServerPort}/health`,
        LOCAL_SERVER_HEALTH_TIMEOUT_MS,
      );
      return healthRes.ok;
    } catch {
      return false;
    }
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimeout || this.ws) return;

    if (this.reconnectAttempt >= LOCAL_SERVER_RECONNECT_RETRIES) {
      this.options.dispatch({
        type: 'connection.set',
        status: 'disconnected',
        message: '连接断开，重连失败',
      });
      return;
    }

    this.reconnectAttempt += 1;
    const attempt = this.reconnectAttempt;
    const retryText = `连接断开，${LOCAL_SERVER_RECONNECT_DELAY_MS / 1000}s 后重连 ${attempt}/${LOCAL_SERVER_RECONNECT_RETRIES}`;
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
        this.appendSystemMessage(`重连失败: ${message}`);
        this.scheduleReconnect();
      });
    }, LOCAL_SERVER_RECONNECT_DELAY_MS);
  }

  private async reconnect() {
    if (this.disposed || this.ws) return;

    const healthy = await this.checkLocalServerHealth();
    if (this.disposed || this.ws) return;

    if (!healthy) {
      this.scheduleReconnect();
      return;
    }

    this.connectWebSocket();
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
        this.appendSystemMessage('无法加载宠物信息，使用默认名称');
      }
    }
  }

  private handleWsMessage(data: WebSocket.RawData) {
    try {
      const msg = parseLocalAgentServerMessage(data);
      if (!msg || msg.type === 'pong') {
        return;
      }

      if (msg.type === 'event') {
        if (
          msg.event.type === 'human_review.requested'
          || msg.event.type === 'message.completed'
          || msg.event.type === 'error'
        ) {
          this.clearInterruptTimeout();
        }
        this.options.dispatch({
          type: 'event.received',
          event: msg.event,
          now: Date.now(),
          historyCell: makeHistoryMeta(),
        });
        return;
      }

      if (msg.type === 'interrupting') {
        this.options.dispatch({
          type: 'server.interrupting',
          requestId: msg.requestId,
          statusMessage: '正在打断',
        });
        return;
      }

      if (msg.type === 'interrupted') {
        this.clearInterruptTimeout();
        this.options.dispatch({
          type: 'server.interrupted',
          requestId: msg.requestId,
          historyCell: makeHistoryMeta(),
          statusMessage: '已打断',
        });
        return;
      }

      if (msg.type === 'studio_response') {
        this.clearInterruptTimeout();
        this.options.dispatch({
          type: 'server.studio_response',
          requestId: msg.requestId,
          outcome: msg.outcome,
          reply: msg.reply,
          reason: msg.reason,
          historyCell: makeHistoryMeta(),
          stoppedReasonCell: makeHistoryMeta(),
          statusMessage: TUI_TEXT.statusReady,
        });
        return;
      }

      if (msg.type === 'studio_error') {
        this.clearInterruptTimeout();
        this.options.dispatch({
          type: 'server.studio_error',
          requestId: msg.requestId,
          message: msg.message,
          historyCell: makeHistoryMeta(),
          statusMessage: 'Studio 出错,已恢复输入',
        });
        return;
      }

      if (msg.type === 'error') {
        this.clearInterruptTimeout();
        this.options.dispatch({
          type: 'server.error',
          requestId: msg.requestId,
          message: msg.message,
          historyCell: makeHistoryMeta(),
          statusMessage: TUI_TEXT.statusErrorRecovered,
        });
      }
    } catch {
      // ignore malformed messages
    }
  }

  private getOpenWebSocket() {
    return this.ws?.readyState === WebSocket.OPEN ? this.ws : null;
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
