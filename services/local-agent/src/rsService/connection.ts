import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { type RSServicePaths, validateEndpoint } from './paths';
import {
  asRecord,
  receiveFrames,
  RS_SERVICE_PROTOCOL_VERSION,
  RSServiceError,
  sendFrame,
} from './transport';

export type RSContractRef = Readonly<{ contract: string; version: number }>;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const CONNECT_TIMEOUT_MS = 5_000;

/**
 * One authenticated connection to the RS service.
 *
 * Opened for one RS contract (a client of that contract) or for none (an
 * admin connection). When the connection closes, every unanswered request
 * fails with `connection_lost`: its outcome is unknown and it is never
 * replayed.
 */
export class RSServiceConnection {
  private readonly pending = new Map<string, Pending>();
  private readonly closeListeners = new Set<() => void>();
  private open = true;
  private pid = 0;
  private build: string | null = null;

  private constructor(private readonly socket: Socket) {
    receiveFrames(socket, (message) => this.handleMessage(message));
    socket.on('error', () => { /* close reports every outstanding request */ });
    socket.on('close', () => {
      this.open = false;
      for (const request of this.pending.values()) {
        request.reject(new RSServiceError(
          'connection_lost',
          'RS service connection closed before the operation answered; its result is unknown.',
        ));
      }
      this.pending.clear();
      for (const listener of this.closeListeners) listener();
      this.closeListeners.clear();
    });
  }

  static async open(options: Readonly<{
    paths: RSServicePaths;
    token: string;
    rs?: RSContractRef;
    timeoutMs?: number;
  }>): Promise<RSServiceConnection> {
    // Validate before connecting, so a foreign endpoint never receives the token.
    await validateEndpoint(options.paths);
    const socket = connect(options.paths.endpoint);
    const connection = new RSServiceConnection(socket);
    const timer = setTimeout(() => socket.destroy(new RSServiceError(
      'connection_failed',
      'RS service did not answer the connection in time.',
    )), options.timeoutMs ?? CONNECT_TIMEOUT_MS);
    timer.unref();
    try {
      await new Promise<void>((resolvePromise, reject) => {
        socket.once('connect', () => resolvePromise());
        socket.once('error', reject);
      });
      const hello = asRecord(await connection.send({
        op: 'hello',
        protocol: RS_SERVICE_PROTOCOL_VERSION,
        token: options.token,
        ...(options.rs ? { rs: options.rs } : {}),
      }), 'hello response');
      if (typeof hello.pid !== 'number') {
        throw new RSServiceError('invalid_response', 'Invalid RS service handshake.');
      }
      connection.pid = hello.pid;
      connection.build = typeof hello.build === 'string' ? hello.build : null;
      return connection;
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  get servicePid(): number {
    return this.pid;
  }

  /** Identity of the code the service runs, when it reports one. */
  get serviceBuild(): string | null {
    return this.build;
  }

  get isOpen(): boolean {
    return this.open && !this.socket.destroyed;
  }

  onClose(listener: () => void): void {
    if (!this.isOpen) {
      listener();
      return;
    }
    this.closeListeners.add(listener);
  }

  /** Call one operation of the contract this connection was opened for. */
  call(method: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.send({ op: 'call', method, args }, signal);
  }

  admin(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.send({ ...payload, op: 'admin', action });
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    const closed = new Promise<void>((resolvePromise) => this.socket.once('close', () => resolvePromise()));
    this.socket.destroy();
    await closed;
  }

  private send(message: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.isOpen) {
      return Promise.reject(new RSServiceError('connection_lost', 'RS service connection is closed.'));
    }
    const id = randomUUID();
    const cancel = () => {
      try {
        sendFrame(this.socket, { op: 'cancel', requestId: id });
      } catch {
        this.socket.destroy();
      }
    };
    const response = new Promise<unknown>((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      try {
        sendFrame(this.socket, { ...message, id });
      } catch (error) {
        this.pending.delete(id);
        reject(error as Error);
        return;
      }
      if (signal) {
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
      }
    });
    return response.finally(() => signal?.removeEventListener('abort', cancel));
  }

  private handleMessage(message: Record<string, unknown>) {
    const id = typeof message.id === 'string' ? message.id : '';
    const request = this.pending.get(id);
    if (!request) {
      this.socket.destroy(new RSServiceError('invalid_response', 'Unexpected RS service response.'));
      return;
    }
    this.pending.delete(id);
    if (message.ok === true) {
      request.resolve(message.value);
      return;
    }
    const error = message.error && typeof message.error === 'object'
      ? message.error as Record<string, unknown>
      : {};
    request.reject(new RSServiceError(
      typeof error.code === 'string' ? error.code : 'invalid_response',
      typeof error.message === 'string' ? error.message : 'Malformed RS service error response.',
      typeof error.retryable === 'boolean' ? error.retryable : undefined,
      error.details && typeof error.details === 'object' && !Array.isArray(error.details)
        ? error.details as Record<string, unknown>
        : undefined,
    ));
  }
}
