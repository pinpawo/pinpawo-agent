import type {
  AgentClientMessage,
  AgentServerMessage,
  AgentSessionSnapshot,
} from '@pinpawo/agent-session';
import type {
  AgentHostConnection,
  AgentHostConnectionFactory,
} from '../client/agentHostConnection';
import type {
  TuiConnectionStatus,
} from './sessionControllerTypes';
import type { SessionSnapshotReason } from './sessionSnapshot';
import { hostMessageText } from '../i18n/text';

type TimerHandle = ReturnType<typeof setTimeout>;

export type SessionApplicationServerMessage = Exclude<
  AgentServerMessage,
  { type: 'session.snapshot.result' }
>;

export type SessionTransportCoordinatorOptions = {
  connectionFactory: AgentHostConnectionFactory;
  requestIdFactory: () => string;
  reconnectDelaysMs: readonly number[];
  /**
   * `null` disables the synchronization timeout. A transport whose disconnect
   * also terminates the Host (embedded stdio) would otherwise turn a slow cold
   * start into a kill/restart loop.
   */
  snapshotTimeoutMs: number | null;
  /**
   * Newest timeline entries each synchronizing snapshot carries. The session
   * keeps what it already holds before them; a whole read is explicit.
   */
  timelineLimit: number;
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
  /** Whole snapshots read for a caller; never applied to the session. */
  private readonly wholeSnapshotReads = new Map<string, (snapshot: AgentSessionSnapshot | null) => void>();
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
    this.options.onConnection('connecting', 'connecting to host');
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

  /** `whole` asks for the entire timeline instead of the newest entries. */
  requestCompletionSnapshot(options: { whole?: boolean } = {}) {
    this.requestSnapshot('completion', options.whole);
  }

  requestManualSnapshot() {
    this.requestSnapshot('manual');
  }

  invalidateCompletionSnapshotState() {
    for (const [requestId, reason] of this.snapshotRequests) {
      if (reason === 'completion' || reason === 'manual') {
        this.snapshotRequests.set(requestId, 'completion-metadata');
      }
    }
  }

  /**
   * Read the session's whole timeline once, for a reader such as the
   * transcript pager. `null` when the Host cannot answer.
   */
  readWholeSnapshot(): Promise<AgentSessionSnapshot | null> {
    const requestId = this.options.requestIdFactory();
    if (!this.connection.isConnected()) return Promise.resolve(null);
    return new Promise((resolve) => {
      let timer: TimerHandle | null = null;
      this.wholeSnapshotReads.set(requestId, (snapshot) => {
        if (timer) this.options.clearTimer(timer);
        this.wholeSnapshotReads.delete(requestId);
        resolve(snapshot);
      });
      if (!this.connection.send({ type: 'session.snapshot.get', requestId })) {
        this.wholeSnapshotReads.get(requestId)?.(null);
        return;
      }
      if (this.options.snapshotTimeoutMs !== null) {
        timer = this.options.setTimer(
          () => this.wholeSnapshotReads.get(requestId)?.(null),
          this.options.snapshotTimeoutMs,
        );
      }
    });
  }

  clearSnapshotRequests() {
    this.clearSnapshotTimer();
    this.snapshotRequests.clear();
    for (const finish of [...this.wholeSnapshotReads.values()]) finish(null);
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
    const wholeRead = (message.type === 'session.snapshot.result' || message.type === 'session.error')
      ? this.wholeSnapshotReads.get(message.requestId)
      : undefined;
    if (wholeRead) {
      wholeRead(message.type === 'session.snapshot.result' ? message.snapshot : null);
      return;
    }
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
        this.options.onConnection('error', hostMessageText(message));
      } else {
        this.options.onConnection(
          'ready',
          `snapshot refresh failed: ${hostMessageText(message)}`,
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

  private requestSnapshot(reason: SessionSnapshotReason, whole = false) {
    if (!this.connection.isConnected()) {
      if (!isCompletionSnapshotReason(reason)) {
        this.scheduleReconnect();
      }
      return;
    }
    const requestId = this.options.requestIdFactory();
    this.snapshotRequests.set(requestId, reason);
    if (!this.connection.send({
      type: 'session.snapshot.get',
      requestId,
      ...(whole ? {} : { timelineLimit: this.options.timelineLimit }),
    })) {
      this.snapshotRequests.delete(requestId);
      if (!isCompletionSnapshotReason(reason)) {
        this.scheduleReconnect();
      }
      return;
    }
    if (!isCompletionSnapshotReason(reason) && this.options.snapshotTimeoutMs !== null) {
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
  return reason === 'completion'
    || reason === 'completion-metadata'
    || reason === 'manual';
}

function formatDelay(delayMs: number) {
  return delayMs < 1_000
    ? `${delayMs}ms`
    : `${Math.round(delayMs / 100) / 10}s`;
}
