import type { ToolkitAvailability } from '@pinpawo/pet-agent';
import type { RSServiceConnection } from '../../rsService/connection';
import { type RSCallFailure, RSContractClient } from '../../rsService/contractClient';
import type { RSServicePaths } from '../../rsService/paths';
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

/** The calling Host's environment, which its commands run in. */
function hostEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

export type ShellRSClientOptions = Readonly<{
  paths?: RSServicePaths;
  /** How to reach the service; defaults to starting it when none runs. */
  connect?: () => Promise<RSServiceConnection>;
  /** Overridable so the Windows path can be tested anywhere. */
  platform?: NodeJS.Platform;
}>;

const WINDOWS_UNAVAILABLE = 'ShellRS has no Windows implementation yet; shell toolkits are unavailable on Windows.';

/**
 * The Host's connection to ShellRS.
 *
 * ShellRS runs only in the standalone RS service, where `PosixShellRS` holds
 * the environment and the logical sessions. This client is transport, not a
 * second kind of ShellRS: it forwards each operation of the {@link ShellRS}
 * interface, so Toolkits cannot tell it from the implementation. The
 * connection is re-established on demand, so a service restart only costs the
 * calls that were in flight. This Host disconnecting, or exiting, leaves the
 * sessions and their processes running, and a later Host using the same Agent
 * session reaches them again.
 */
function toShellRSError(failure: RSCallFailure): Error {
  if (failure.kind === 'unavailable') return new ShellRSError('unavailable', failure.message);
  if (failure.kind === 'result_unknown') {
    return new ShellRSError(
      'result_unknown',
      'Lost the ShellRS service while this operation was running; its result is unknown and it was not retried.'
      + ' A command that started stays in this session: list its processes to find it.',
    );
  }
  const { error } = failure;
  return SHELL_RS_ERROR_CODES.has(error.code)
    ? new ShellRSError(error.code as ShellRSErrorCode, error.message)
    : error;
}

export class ShellRSClient implements ShellRS {
  readonly contract = SHELL_RS_CONTRACT;
  readonly version = SHELL_RS_VERSION;

  private readonly transport: RSContractClient;

  constructor(options: ShellRSClientOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.transport = new RSContractClient({
      rs: { contract: SHELL_RS_CONTRACT, version: SHELL_RS_VERSION },
      label: 'ShellRS',
      ...(options.paths ? { paths: options.paths } : {}),
      ...(options.connect ? { connect: options.connect } : {}),
      // The service has no Windows implementation (or endpoint) to start.
      ...(platform === 'win32' ? { unsupportedReason: WINDOWS_UNAVAILABLE } : {}),
      toError: toShellRSError,
    });
  }

  /** Host startup: reach the service now so failures surface as status. */
  async start(): Promise<void> {
    await this.transport.start();
  }

  async status(): Promise<ToolkitAvailability> {
    return await this.transport.status();
  }

  async ensureSession(agentSessionId: string): Promise<void> {
    await this.transport.call('ensureSession', { agentSessionId });
  }

  async exec(agentSessionId: string, request: ShellExecRequest): Promise<ShellExecResult> {
    const { signal, ...rest } = request;
    if (signal?.aborted) return { status: 'aborted', stdout: '', stderr: '' };
    const result = await this.transport.call(
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
    return await this.transport.call('wait', { agentSessionId, processId, timeoutMs }) as ShellProcessOutput;
  }

  async read(agentSessionId: string, processId: string): Promise<ShellProcessOutput> {
    return await this.transport.call('read', { agentSessionId, processId }) as ShellProcessOutput;
  }

  async terminate(agentSessionId: string, processId: string): Promise<ShellProcessSnapshot> {
    return await this.transport.call('terminate', { agentSessionId, processId }) as ShellProcessSnapshot;
  }

  async list(agentSessionId: string): Promise<readonly ShellProcessSnapshot[]> {
    return await this.transport.call('list', { agentSessionId }) as readonly ShellProcessSnapshot[];
  }

  /**
   * Close this Host's connection. The service, its sessions and their
   * processes keep running; stopping them is the service's own management.
   */
  async dispose(): Promise<void> {
    await this.transport.dispose();
  }
}
