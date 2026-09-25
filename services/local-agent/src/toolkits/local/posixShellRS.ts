import type { ToolkitAvailability } from '@pinpawo/pet-agent';
import type { ProcessExecutor } from './processExecutor';
import { ProcessRegistry, type ProcessSnapshot } from './processRegistry';
import { posixProcessExecutor } from './processTree';
import {
  describeShellCommand,
  SHELL_RS_CONTRACT,
  SHELL_RS_VERSION,
  ShellRSError,
  type ShellExecRequest,
  type ShellExecResult,
  type ShellProcessOutput,
  type ShellProcessSnapshot,
  type ShellRS,
} from './shellRS';

function snapshot(record: ProcessSnapshot): ShellProcessSnapshot {
  return Object.freeze({
    processId: record.processId,
    command: record.command,
    cwd: record.cwd,
    pid: record.pid,
    startedAt: record.startedAt,
    status: record.status,
    exitCode: record.exitCode,
    exitedAt: record.exitedAt,
  });
}

/** A process as RS management sees it: with the session that holds it. */
export type ShellManagedProcess = ShellProcessSnapshot & Readonly<{ agentSessionId: string }>;

function requireSessionId(agentSessionId: string) {
  if (typeof agentSessionId !== 'string' || !agentSessionId.trim()) {
    throw new ShellRSError('unavailable', 'ShellRS requires an Agent session id.');
  }
  return agentSessionId;
}

export type PosixShellRSOptions = Readonly<{
  executor?: ProcessExecutor;
  /** Overridable so the unavailable-platform path can be tested anywhere. */
  platform?: NodeJS.Platform;
}>;

/**
 * POSIX implementation of {@link ShellRS}.
 *
 * Commands run as independent processes in their own process groups over
 * pipes (`/bin/sh -c` for shell strings, direct spawn for argv). A logical
 * session is the set of handles its Agent session has left running; it is
 * established lazily and never closed by the Host or the Agent.
 *
 * It lives in whichever process created it: normally the standalone RS
 * service (see `shellRSService.ts`), or a Host directly when it runs
 * in-process. `dispose` ends whatever it still holds when that owner stops.
 */
export class PosixShellRS implements ShellRS {
  readonly contract = SHELL_RS_CONTRACT;
  readonly version = SHELL_RS_VERSION;

  private readonly registry: ProcessRegistry;
  private readonly platform: NodeJS.Platform;
  private readonly sessions = new Set<string>();
  private disposed = false;

  constructor(options: PosixShellRSOptions = {}) {
    this.registry = new ProcessRegistry(options.executor ?? posixProcessExecutor);
    this.platform = options.platform ?? process.platform;
  }

  status(): ToolkitAvailability {
    if (this.platform === 'win32') {
      return {
        available: false,
        reason: 'ShellRS has no Windows implementation yet; shell toolkits are unavailable on Windows.',
      };
    }
    if (this.disposed) {
      return { available: false, reason: 'ShellRS instance has been disposed.' };
    }
    return { available: true };
  }

  ensureSession(agentSessionId: string): void {
    const availability = this.status();
    if (!availability.available) {
      throw new ShellRSError('unavailable', availability.reason);
    }
    this.sessions.add(requireSessionId(agentSessionId));
  }

  async exec(agentSessionId: string, request: ShellExecRequest): Promise<ShellExecResult> {
    this.ensureSession(agentSessionId);
    const command = 'shell' in request.command
      ? request.command.shell
      : { argv: request.command.argv };
    const outcome = await this.registry.processExecutor.run({
      command,
      cwd: request.cwd,
      timeoutMs: request.waitMs,
      maxOutputChars: request.maxOutputChars,
      ...(request.env ? { env: request.env } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      yieldOnTimeout: request.onTimeout === 'yield',
    });

    if (outcome.status === 'exited') {
      if (outcome.pid !== undefined) {
        // A command can exit cleanly having left work behind (`npm run dev &`).
        // Those children stay in the original process group; tracking it keeps
        // disposal able to reach them.
        this.registry.trackOrphanGroup(outcome.pid);
      }
      return {
        status: 'exited',
        code: outcome.code,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
      };
    }
    if (outcome.status !== 'yielded') return outcome;

    const { handle } = outcome;
    let record: ProcessSnapshot;
    try {
      record = this.registry.register({
        handle,
        sessionId: agentSessionId,
        command: describeShellCommand(request.command),
        cwd: request.cwd,
        // The output so far is returned with this result, so the next read
        // starts from what comes next.
        outputAlreadyDelivered: true,
      });
    } catch (error) {
      handle.terminate();
      throw error;
    }
    return {
      status: 'yielded',
      process: snapshot(record),
      stdout: handle.stdout,
      stderr: handle.stderr,
    };
  }

  async wait(
    agentSessionId: string,
    processId: string,
    timeoutMs: number,
  ): Promise<ShellProcessOutput> {
    this.ensureSession(agentSessionId);
    const result = await this.registry.wait(processId, agentSessionId, timeoutMs);
    return { ...result, process: snapshot(result.process) };
  }

  async read(agentSessionId: string, processId: string): Promise<ShellProcessOutput> {
    this.ensureSession(agentSessionId);
    const result = await this.registry.drain(processId, agentSessionId);
    return { ...result, process: snapshot(result.process) };
  }

  async terminate(agentSessionId: string, processId: string): Promise<ShellProcessSnapshot> {
    this.ensureSession(agentSessionId);
    return snapshot(await this.registry.terminate(processId, agentSessionId));
  }

  async list(agentSessionId: string): Promise<readonly ShellProcessSnapshot[]> {
    this.ensureSession(agentSessionId);
    return Object.freeze(this.registry.list(agentSessionId).map(snapshot));
  }

  /**
   * RS management, not part of {@link ShellRS}: every process this instance
   * holds, with the session holding it.
   */
  listAllProcesses(): readonly ShellManagedProcess[] {
    return Object.freeze(this.registry.listAll().map((record) => Object.freeze({
      ...snapshot(record),
      agentSessionId: record.sessionId,
    })));
  }

  /** RS management: terminate a process whichever session holds it. */
  async terminateProcess(processId: string): Promise<ShellManagedProcess> {
    const agentSessionId = this.registry.sessionOf(processId);
    const record = await this.registry.terminate(processId, agentSessionId);
    return Object.freeze({ ...snapshot(record), agentSessionId });
  }

  /** RS management: how many logical sessions this instance has seen. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * End every process this instance holds. Owned by whoever created the
   * instance (an in-process Host, or the RS service when it stops); it is not
   * a session operation.
   */
  async dispose(): Promise<{ terminated: number }> {
    const terminated = this.registry.listAll()
      .filter((record) => record.status === 'running').length;
    this.disposed = true;
    this.sessions.clear();
    await this.registry.stopAll();
    return { terminated };
  }
}
