import type { ToolkitAvailability } from '@pinpawo/pet-agent';
import type { RSServiceConnection } from '../../rsService/connection';
import { ensureRSService } from '../../rsService/launcher';
import { resolveRSServicePaths, type RSServicePaths } from '../../rsService/paths';
import { RSServiceError } from '../../rsService/transport';
import {
  SHELL_RS_CONTRACT,
  SHELL_RS_VERSION,
  ShellRSError,
  type ShellExecRequest,
  type ShellExecResult,
  type ShellProcessOutput,
  type ShellProcessSnapshot,
  type ShellRS,
  type ShellRSErrorCode,
} from './shellRS';

const SHELL_RS_ERROR_CODES: ReadonlySet<string> = new Set<ShellRSErrorCode>([
  'unknown_process',
  'other_session',
  'too_many_processes',
  'unavailable',
  'result_unknown',
]);

/** `spawn_failed` as the service sends it: the error reduced to data. */
type WireSpawnFailed = Readonly<{
  status: 'spawn_failed';
  error: Readonly<{ message: string; code?: string }>;
}>;

/** Minimum gap between reconnect attempts made by `status()`. */
const STATUS_RECONNECT_INTERVAL_MS = 3_000;

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** The calling Host's environment, which its commands run in. */
function hostEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

export type RemoteShellRSOptions = Readonly<{
  paths?: RSServicePaths;
  /** How to reach the service; defaults to starting it when none runs. */
  connect?: () => Promise<RSServiceConnection>;
}>;

/**
 * {@link ShellRS} backed by the standalone RS service.
 *
 * Toolkits see the same interface as the in-process implementation. The
 * connection is re-established on demand, so a service restart only costs
 * the calls that were in flight. Logical sessions live in the service: this
 * Host disconnecting, or exiting, leaves them and their processes running,
 * and a later Host using the same Agent session reaches them again.
 */
export class RemoteShellRS implements ShellRS {
  readonly contract = SHELL_RS_CONTRACT;
  readonly version = SHELL_RS_VERSION;

  private readonly connectToService: () => Promise<RSServiceConnection>;
  private connection: RSServiceConnection | null = null;
  private connecting: Promise<RSServiceConnection> | null = null;
  private lastError: string | null = null;
  private lastStatusAttemptAt = 0;
  private disposed = false;

  constructor(options: RemoteShellRSOptions = {}) {
    this.connectToService = options.connect ?? (async () => await ensureRSService({
      paths: options.paths ?? resolveRSServicePaths(),
      rs: { contract: SHELL_RS_CONTRACT, version: SHELL_RS_VERSION },
    }));
  }

  /** Host startup: reach the service now so failures surface as status. */
  async start(): Promise<void> {
    await this.connect();
  }

  async status(): Promise<ToolkitAvailability> {
    if (this.disposed) {
      return { available: false, reason: 'ShellRS client has been disposed.' };
    }
    if (!this.connection?.isOpen) {
      if (Date.now() - this.lastStatusAttemptAt < STATUS_RECONNECT_INTERVAL_MS) {
        return this.unavailable();
      }
      this.lastStatusAttemptAt = Date.now();
      try {
        await this.connect();
      } catch {
        return this.unavailable();
      }
    }
    try {
      return await this.call('status', null) as ToolkitAvailability;
    } catch (error) {
      return { available: false, reason: describeError(error) };
    }
  }

  async ensureSession(agentSessionId: string): Promise<void> {
    await this.call('ensureSession', { agentSessionId });
  }

  async exec(agentSessionId: string, request: ShellExecRequest): Promise<ShellExecResult> {
    const { signal, ...rest } = request;
    if (signal?.aborted) return { status: 'aborted', stdout: '', stderr: '' };
    const result = await this.call(
      'exec',
      { agentSessionId, request: { ...rest, baseEnv: hostEnvironment() } },
      signal,
    ) as Exclude<ShellExecResult, { status: 'spawn_failed' }> | WireSpawnFailed;
    if (result.status !== 'spawn_failed') return result;
    const error = Object.assign(
      new Error(result.error.message),
      result.error.code ? { code: result.error.code } : {},
    );
    return { status: 'spawn_failed', error };
  }

  async wait(agentSessionId: string, processId: string, timeoutMs: number): Promise<ShellProcessOutput> {
    return await this.call('wait', { agentSessionId, processId, timeoutMs }) as ShellProcessOutput;
  }

  async read(agentSessionId: string, processId: string): Promise<ShellProcessOutput> {
    return await this.call('read', { agentSessionId, processId }) as ShellProcessOutput;
  }

  async terminate(agentSessionId: string, processId: string): Promise<ShellProcessSnapshot> {
    return await this.call('terminate', { agentSessionId, processId }) as ShellProcessSnapshot;
  }

  async list(agentSessionId: string): Promise<readonly ShellProcessSnapshot[]> {
    return await this.call('list', { agentSessionId }) as readonly ShellProcessSnapshot[];
  }

  /**
   * Close this Host's connection. The service, its sessions and their
   * processes keep running; stopping them is the service's own management.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const connection = this.connection;
    this.connection = null;
    await connection?.close();
  }

  private unavailable(): ToolkitAvailability {
    return {
      available: false,
      reason: `ShellRS service is unavailable${this.lastError ? `: ${this.lastError}` : '.'}`,
    };
  }

  private async connect(): Promise<RSServiceConnection> {
    if (this.disposed) throw new ShellRSError('unavailable', 'ShellRS client has been disposed.');
    if (this.connection?.isOpen) return this.connection;
    this.connecting ??= (async () => {
      try {
        const connection = await this.connectToService();
        if (this.disposed) {
          await connection.close();
          throw new ShellRSError('unavailable', 'ShellRS client has been disposed.');
        }
        this.connection = connection;
        this.lastError = null;
        connection.onClose(() => {
          if (this.connection === connection) this.connection = null;
        });
        return connection;
      } catch (error) {
        this.lastError = describeError(error);
        throw error;
      } finally {
        this.connecting = null;
      }
    })();
    return await this.connecting;
  }

  private async call(method: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    let connection: RSServiceConnection;
    try {
      connection = await this.connect();
    } catch (error) {
      if (error instanceof ShellRSError) throw error;
      throw new ShellRSError('unavailable', `ShellRS service is unavailable: ${describeError(error)}`);
    }
    try {
      return await connection.call(method, args, signal);
    } catch (error) {
      if (!(error instanceof RSServiceError)) throw error;
      if (error.code === 'connection_lost') {
        throw new ShellRSError(
          'result_unknown',
          'Lost the ShellRS service while this operation was running; its result is unknown and it was not retried.'
          + ' A command that started stays in this session: list its processes to find it.',
        );
      }
      if (SHELL_RS_ERROR_CODES.has(error.code)) {
        throw new ShellRSError(error.code as ShellRSErrorCode, error.message);
      }
      throw error;
    }
  }
}
