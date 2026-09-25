import type { ToolkitAvailability } from '@pinpawo/pet-agent';
import type { RSContractRef, RSServiceConnection } from './connection';
import { ensureRSService } from './launcher';
import { resolveRSServicePaths, type RSServicePaths } from './paths';
import { RSServiceError } from './transport';

/** Why a call did not produce the contract's result. */
export type RSCallFailure =
  /** The service could not be reached; the operation did not start. */
  | Readonly<{ kind: 'unavailable'; message: string }>
  /** The connection was lost mid-call: the operation may or may not have run. */
  | Readonly<{ kind: 'result_unknown' }>
  /** The contract's own error, as the service reported it. */
  | Readonly<{ kind: 'error'; error: RSServiceError }>;

export type RSContractClientOptions = Readonly<{
  rs: RSContractRef;
  /** How the RS is named in messages, such as `ShellRS`. */
  label: string;
  paths?: RSServicePaths;
  /** How to reach the service; defaults to starting it when none runs. */
  connect?: () => Promise<RSServiceConnection>;
  /** Set when this machine cannot run the RS at all; nothing is started. */
  unsupportedReason?: string;
  /** Turn a failure into the error type the contract's callers expect. */
  toError: (failure: RSCallFailure) => Error;
}>;

/** Minimum gap between reconnect attempts made by `status()`. */
const STATUS_RECONNECT_INTERVAL_MS = 3_000;

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Host's connection to one RS contract in the RS service.
 *
 * Transport only: each contract's client (`ShellRSClient`, `BrowserRSClient`)
 * implements its typed interface on top of `call` and decides what its
 * failures look like. The connection is re-established on demand, so a
 * service restart only costs the calls that were in flight. Disposing closes
 * this Host's connection and nothing else.
 */
export class RSContractClient {
  private readonly connectToService: () => Promise<RSServiceConnection>;
  private connection: RSServiceConnection | null = null;
  private connecting: Promise<RSServiceConnection> | null = null;
  private lastError: string | null = null;
  private lastStatusAttemptAt = 0;
  private disposed = false;

  constructor(private readonly options: RSContractClientOptions) {
    this.connectToService = options.connect ?? (async () => {
      if (options.unsupportedReason) {
        throw new RSServiceError('unsupported', options.unsupportedReason);
      }
      return await ensureRSService({
        paths: options.paths ?? resolveRSServicePaths(),
        rs: options.rs,
      });
    });
  }

  /**
   * Host startup: reach the service and require the RS to be available. A
   * failure is retried by the Host with backoff, which then re-reads the
   * availability of the Toolkits built on this RS.
   */
  async start(): Promise<void> {
    await this.connect();
    const availability = await this.status();
    if (!availability.available) throw new Error(availability.reason);
  }

  /** The RS's own availability, or why the service cannot be reached. */
  async status(): Promise<ToolkitAvailability> {
    if (this.disposed) {
      return { available: false, reason: `${this.options.label} client has been disposed.` };
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

  /** Call one operation of the contract; failures go through `toError`. */
  async call(method: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    let connection: RSServiceConnection;
    try {
      connection = await this.connect();
    } catch (error) {
      throw this.options.toError({
        kind: 'unavailable',
        message: `${this.options.label} service is unavailable: ${describeError(error)}`,
      });
    }
    try {
      return await connection.call(method, args, signal);
    } catch (error) {
      if (!(error instanceof RSServiceError)) throw error;
      if (error.code === 'connection_lost') {
        throw this.options.toError({ kind: 'result_unknown' });
      }
      throw this.options.toError({ kind: 'error', error });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const connection = this.connection;
    this.connection = null;
    await connection?.close();
  }

  /** The open connection, for tests that need to drop it. */
  get currentConnection(): RSServiceConnection | null {
    return this.connection;
  }

  private unavailable(): ToolkitAvailability {
    return {
      available: false,
      reason: `${this.options.label} service is unavailable${this.lastError ? `: ${this.lastError}` : '.'}`,
    };
  }

  private async connect(): Promise<RSServiceConnection> {
    if (this.disposed) throw new Error(`${this.options.label} client has been disposed.`);
    if (this.connection?.isOpen) return this.connection;
    this.connecting ??= (async () => {
      try {
        const connection = await this.connectToService();
        if (this.disposed) {
          await connection.close();
          throw new Error(`${this.options.label} client has been disposed.`);
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
}
