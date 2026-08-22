import type {
  AgentClientMessage,
  AgentServerMessage,
  AgentSessionSnapshot,
} from '@pinpawo/agent-session';
import type {
  AgentHostConnection,
  AgentHostConnectionFactory,
} from '../client/localHostConnection';
import type {
  TuiConnectionStatus,
} from './sessionControllerTypes';
import type { SessionSnapshotReason } from './sessionSnapshot';

type TimerHandle = ReturnType<typeof setTimeout>;

export type SessionApplicationServerMessage = Exclude<
  AgentServerMessage,
  { type: 'session.snapshot.result' }
>;

export type SessionTransportCoordinatorOptions = {
  connectionFactory: AgentHostConnectionFactory;
  requestIdFactory: () => string;
  reconnectDelaysMs: readonly number[];
  snapshotTimeoutMs: number;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (timer: TimerHandle) => void;
  onConnection: (
    connection: TuiConnectionStatus,
    connectionDetail?: string,
  ) => void;
  onSnapshot: (
    snapshot: AgentSessionSnapshot,
    reason: SessionSnapshotReason,
  ) => void;
  onMessage: (message: SessionApplicationServerMessage) => void;
  onDisconnected: () => void;
};

export class SessionTransportCoordinator {
  private readonly connection: AgentHostConnection;
  private readonly snapshotRequests = new Map<string, SessionSnapshotReason>();
  private started = false;
  private reconnectAttempt = 0;
  private reconnectTimer: TimerHandle | null = null;
  private snapshotTimer: TimerHandle | null = null;

  constructor(private readonly options: SessionTransportCoordinatorOptions) {
    this.connection = options.connectionFactory({
      onOpen: () => this.handleOpen(),
      onMessage: (message) => this.handleMessage(message),
      onClose: () => this.handleClose(),
      onError: (error) => this.handleError(error),
    });
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.reconnectAttempt = 0;
    this.options.onConnection('connecting', 'connecting to local-agent');
    this.connection.connect();
  }

  stop() {
    this.started = false;
    this.clearReconnectTimer();
    this.clearSnapshotRequests();
    this.connection.disconnect();
    this.options.onConnection('idle');
  }

  send(message: AgentClientMessage) {
    return this.connection.send(message);
  }

  isConnected() {
    return this.connection.isConnected();
  }

  requestCompletionSnapshot() {
    this.requestSnapshot('completion');
  }

  invalidateCompletionSnapshotState() {
    for (const [requestId, reason] of this.snapshotRequests) {
      if (reason === 'completion') {
        this.snapshotRequests.set(requestId, 'completion-metadata');
      }
    }
  }

  clearSnapshotRequests() {
    this.clearSnapshotTimer();
    this.snapshotRequests.clear();
  }

  private handleOpen() {
    if (!this.started) {
      this.connection.disconnect();
      return;
    }
    const reason: SessionSnapshotReason = this.reconnectAttempt > 0
      ? 'reconnect'
      : 'startup';
    this.options.onConnection(
      reason === 'reconnect' ? 'reconnecting' : 'connecting',
      'synchronizing session',
    );
    this.requestSnapshot(reason);
  }

  private handleMessage(message: AgentServerMessage) {
    if (message.type === 'session.snapshot.result') {
      const reason = this.snapshotRequests.get(message.requestId);
      if (!reason) return;
      this.snapshotRequests.delete(message.requestId);
      if (!isCompletionSnapshotReason(reason)) {
        this.clearSnapshotTimer();
        this.reconnectAttempt = 0;
      }
      this.options.onSnapshot(message.snapshot, reason);
      return;
    }

    if (message.type === 'session.error') {
      const reason = this.snapshotRequests.get(message.requestId);
      if (!reason) {
        this.options.onMessage(message);
        return;
      }
      this.snapshotRequests.delete(message.requestId);
      if (!isCompletionSnapshotReason(reason)) {
        this.clearSnapshotTimer();
        this.options.onConnection('error', message.message);
      } else {
        this.options.onConnection(
          'ready',
          `snapshot refresh failed: ${message.message}`,
        );
      }
      return;
    }

    this.options.onMessage(message);
  }

  private handleClose() {
    if (!this.started) return;
    this.clearSnapshotRequests();
    this.options.onDisconnected();
    this.scheduleReconnect();
  }

  private handleError(error: Error) {
    if (!this.started) return;
    this.options.onConnection('error', error.message);
  }

  private requestSnapshot(reason: SessionSnapshotReason) {
    if (!this.connection.isConnected()) {
      if (!isCompletionSnapshotReason(reason)) {
        this.scheduleReconnect();
      }
      return;
    }
    const requestId = this.options.requestIdFactory();
    this.snapshotRequests.set(requestId, reason);
    if (!this.connection.send({ type: 'session.snapshot.get', requestId })) {
      this.snapshotRequests.delete(requestId);
      if (!isCompletionSnapshotReason(reason)) {
        this.scheduleReconnect();
      }
      return;
    }
    if (!isCompletionSnapshotReason(reason)) {
      this.clearSnapshotTimer();
      this.snapshotTimer = this.options.setTimer(() => {
        this.snapshotTimer = null;
        if (!this.started || !this.snapshotRequests.has(requestId)) return;
        this.snapshotRequests.delete(requestId);
        this.connection.disconnect();
        this.options.onConnection(
          'reconnecting',
          'session synchronization timed out',
        );
        this.scheduleReconnect();
      }, this.options.snapshotTimeoutMs);
    }
  }

  private scheduleReconnect() {
    if (!this.started || this.reconnectTimer) return;
    const delayIndex = Math.min(
      this.reconnectAttempt,
      this.options.reconnectDelaysMs.length - 1,
    );
    const delay = this.options.reconnectDelaysMs[delayIndex]!;
    this.reconnectAttempt += 1;
    const attemptDetail = this.reconnectAttempt
      <= this.options.reconnectDelaysMs.length
      ? `${this.reconnectAttempt}/${this.options.reconnectDelaysMs.length}`
      : `background attempt ${this.reconnectAttempt}`;
    this.options.onConnection(
      'reconnecting',
      `retrying in ${formatDelay(delay)} (${attemptDetail})`,
    );
    this.reconnectTimer = this.options.setTimer(() => {
      this.reconnectTimer = null;
      if (this.started) {
        this.connection.connect();
      }
    }, delay);
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    this.options.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearSnapshotTimer() {
    if (!this.snapshotTimer) return;
    this.options.clearTimer(this.snapshotTimer);
    this.snapshotTimer = null;
  }
}

function isCompletionSnapshotReason(reason: SessionSnapshotReason) {
  return reason === 'completion' || reason === 'completion-metadata';
}

function formatDelay(delayMs: number) {
  return delayMs < 1_000
    ? `${delayMs}ms`
    : `${Math.round(delayMs / 100) / 10}s`;
}
