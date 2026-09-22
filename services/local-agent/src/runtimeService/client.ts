import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { validateRuntimeEndpoint } from './endpoint';
import { RUNTIME_PROTOCOL_VERSION, RuntimeServiceError, receive, record, send } from './protocol';
import type { RuntimeCaller, RuntimeExecution } from './types';

export type RuntimeBinding = Readonly<{ instanceId: string; runtimeType: string }>;
export type RuntimeServiceStatus = {
  pid: number;
  protocol: number;
  instances: Array<{
    instanceId: string;
    type: string;
    state: string;
    error?: string;
    details?: unknown;
  }>;
};

export class RuntimeClient implements RuntimeCaller {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private connected = true;
  private identity = '';
  private servicePid = 0;
  private instanceBindings: Readonly<Record<string, RuntimeBinding>> = Object.freeze({});

  private constructor(private readonly socket: Socket) {
    receive(socket, (message) => {
      const id = typeof message.id === 'string' ? message.id : '';
      const request = this.pending.get(id);
      if (!request) throw new RuntimeServiceError('invalid_response', 'Unexpected Runtime response.');
      if (message.ok === true) {
        this.pending.delete(id);
        request.resolve(message.value);
      }
      else {
        const error = record(message.error);
        if (message.ok !== false || typeof error.code !== 'string' || typeof error.message !== 'string') {
          throw new RuntimeServiceError('invalid_response', 'Malformed Runtime error response.');
        }
        this.pending.delete(id);
        request.reject(Object.assign(new RuntimeServiceError(String(error.code), String(error.message)), {
          name: typeof error.name === 'string' ? error.name : 'RuntimeServiceError',
          ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
          ...(error.details && typeof error.details === 'object' ? { details: error.details } : {}),
        }));
      }
    });
    socket.on('error', () => { /* close invalidates every outstanding call */ });
    socket.on('close', () => {
      this.connected = false;
      for (const request of this.pending.values()) request.reject(new RuntimeServiceError(
        'connection_lost', 'Runtime connection closed; unfinished operation results and cleanup are unconfirmed. Reconnect explicitly; do not replay operations.',
      ));
      this.pending.clear();
    });
  }

  static async connect(options: {
    endpoint: string;
    token: string;
    toolkits: Readonly<Record<string, string>>;
    administrative?: boolean;
    timeoutMs?: number;
  }): Promise<RuntimeClient> {
    await validateRuntimeEndpoint(options.endpoint);
    const socket = connect(options.endpoint);
    const client = new RuntimeClient(socket);
    const timer = setTimeout(() => socket.destroy(), options.timeoutMs ?? 5000);
    timer.unref();
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
        socket.once('close', () => reject(new RuntimeServiceError('connection_failed', 'Runtime connection could not be established.')));
      });
      const response = record(await client.request({
        op: 'hello', protocol: RUNTIME_PROTOCOL_VERSION, token: options.token,
        toolkits: options.toolkits, administrative: options.administrative ?? false,
      }));
      if (typeof response.clientId !== 'string' || typeof response.pid !== 'number') {
        throw new RuntimeServiceError('invalid_response', 'Invalid Runtime handshake.');
      }
      client.identity = response.clientId;
      client.servicePid = response.pid;
      client.instanceBindings = Object.freeze(Object.fromEntries(
        Object.entries(record(response.bindings)).map(([name, value]) => {
          const binding = record(value);
          if (typeof binding.instanceId !== 'string' || typeof binding.runtimeType !== 'string') {
            throw new RuntimeServiceError('invalid_response', 'Invalid Runtime binding.');
          }
          return [name, Object.freeze({ instanceId: binding.instanceId, runtimeType: binding.runtimeType })];
        }),
      ));
      return client;
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  get clientId(): string { return this.identity; }
  get pid(): number { return this.servicePid; }
  get bindings(): Readonly<Record<string, RuntimeBinding>> { return this.instanceBindings; }
  get isConnected(): boolean { return this.connected && !this.socket.destroyed; }

  private request(message: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.isConnected) return Promise.reject(new RuntimeServiceError('connection_lost', 'Runtime connection is closed.'));
    if (signal?.aborted) return Promise.reject(new RuntimeServiceError('aborted', 'Runtime operation cancelled before execution.'));
    const id = randomUUID();
    const cancel = () => {
      try { send(this.socket, { op: 'cancel', requestId: id }); }
      catch { this.socket.destroy(); }
    };
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        send(this.socket, { ...message, id });
        signal?.addEventListener('abort', cancel, { once: true });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
    return response.finally(() => signal?.removeEventListener('abort', cancel));
  }

  call(toolkitName: string, method: string, args: unknown, execution: RuntimeExecution, signal?: AbortSignal): Promise<unknown> {
    if (!Object.hasOwn(this.instanceBindings, toolkitName)) {
      return Promise.reject(new RuntimeServiceError('forbidden', 'Toolkit is not bound to this client.'));
    }
    // Pass an explicit serializable scope, never an AbortSignal or arbitrary context object.
    const { threadId, taskId, runId, delegationId, workdir } = execution;
    return this.request({ op: 'call', toolkitName, method, args,
      execution: { threadId, taskId, runId, delegationId, workdir } }, signal);
  }

  async status(): Promise<RuntimeServiceStatus> {
    return await this.request({ op: 'status' }) as RuntimeServiceStatus;
  }

  async stopService(): Promise<void> { await this.request({ op: 'stop' }); }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    this.connected = false;
    const closed = new Promise<void>((resolve) => this.socket.once('close', resolve));
    this.socket.destroy();
    await closed;
  }
}
