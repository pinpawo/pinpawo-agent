import { randomUUID } from 'node:crypto';
import type { ToolkitRuntimeExecutionScope } from '@pinpawo/pet-agent';
import type { ProcessExecutor, ShellRunHandle } from './processExecutor';

/**
 * Session-lifetime registry for shell processes that outlive the tool call
 * that started them.
 *
 * A timed-out command is slow, not failed. #554 lets such a command hand back
 * a handle instead of being killed; this registry is what holds that handle so
 * the model can wait on it, read from it, or terminate it later, and so host
 * shutdown can clean up whatever is still running.
 *
 * Ownership follows the Toolkit runtime lifecycle (#543): processes live on
 * the runtime root, not on a per-execution binding, so releasing an execution
 * does not kill its long-running work. Access is still scoped — only the
 * execution that started a process may operate on it.
 */

export type ManagedProcessStatus =
  | 'running'
  | 'exited'
  | 'terminated';

export type ManagedProcessOwner = Pick<
  ToolkitRuntimeExecutionScope,
  'threadId' | 'runId' | 'delegationId'
>;

export type ManagedProcess = {
  processId: string;
  owner: ManagedProcessOwner;
  command: string;
  cwd: string;
  pid: number;
  startedAt: number;
  status: ManagedProcessStatus;
  exitCode: number | null;
  exitedAt: number | null;
};

export type ProcessSnapshot = Omit<ManagedProcess, never>;

/**
 * What a tool needs to reach the registry on behalf of one execution: the
 * shared registry, plus the identity that scopes access to it.
 */
export type ShellProcessBinding = {
  registry: ProcessRegistry;
  owner: ManagedProcessOwner;
};

export type DrainResult = {
  process: ProcessSnapshot;
  /** Output produced since the previous drain. */
  stdout: string;
  stderr: string;
};

export class ProcessRegistryError extends Error {
  constructor(
    readonly code: 'unknown_process' | 'not_owner' | 'too_many_processes',
    message: string,
  ) {
    super(message);
    this.name = 'ProcessRegistryError';
  }
}

/**
 * Concurrency cap.
 *
 * Deliberately lower than Codex's 64, which runs processes under sandbox
 * isolation we do not have. On overflow we refuse to start rather than evict:
 * evicting would silently kill a build the user is waiting on, whereas a
 * refusal is something the model can see and act on.
 */
export const MAX_ACTIVE_PROCESSES = 16;

/** How long a finished process stays readable before it is reaped. */
export const EXITED_PROCESS_TTL_MS = 5 * 60_000;

/**
 * Grace given to an orphaned group at shutdown.
 *
 * Short on purpose: nothing is waiting on these, and shutdown should not stall
 * on a group that ignores a graceful signal.
 */
const ORPHAN_GROUP_KILL_GRACE_MS = 1_000;

function sameOwner(left: ManagedProcessOwner, right: ManagedProcessOwner) {
  return left.threadId === right.threadId
    && left.runId === right.runId
    && left.delegationId === right.delegationId;
}

type Entry = {
  record: ManagedProcess;
  handle: ShellRunHandle;
  /** Output not yet drained by the owner. */
  pendingStdout: string;
  pendingStderr: string;
  unsubscribe: () => void;
  /**
   * Serializes drain, terminate and exit bookkeeping for one process.
   *
   * Without it a drain racing an exit can double-report or drop output, and a
   * terminate racing an exit can act on a pid that has already been reused.
   */
  lock: Promise<void>;
};

export class ProcessRegistry {
  private readonly entries = new Map<string, Entry>();

  /** Process groups that outlived their command, kept only for cleanup. */
  private readonly orphanGroups = new Set<number>();

  /**
   * How this registry reaches the OS.
   *
   * Ownership, quota, buffering and lifetime are the same everywhere, so the
   * registry never signals a process itself; it asks the executor to.
   *
   * Required rather than defaulted on purpose: defaulting would let a caller
   * pick up POSIX behaviour without meaning to, and the registry is precisely
   * the layer that should not know which platform it is on. `ShellRuntime`
   * makes that choice once, for everyone.
   */
  constructor(private readonly executor: ProcessExecutor) {}

  get size() {
    return this.entries.size;
  }

  /**
   * How commands are run and signalled on this platform.
   *
   * Exposed so a tool that starts processes (`run_shell`) goes through the
   * same executor the registry will later use to terminate them; running
   * through one implementation and killing through another is exactly the
   * mismatch the interface exists to prevent.
   */
  get processExecutor(): ProcessExecutor {
    return this.executor;
  }

  /**
   * Adopt a yielded process.
   *
   * Throws `too_many_processes` when the cap is reached; the caller is
   * expected to terminate the handle it could not hand over.
   */
  register(params: {
    handle: ShellRunHandle;
    owner: ManagedProcessOwner;
    command: string;
    cwd: string;
    /**
     * Treat the output captured so far as already delivered.
     *
     * `run_shell` shows what a command printed before it went to the
     * background, so replaying it on the first `wait_process` would show the
     * model the same lines twice.
     */
    outputAlreadyDelivered?: boolean;
  }): ManagedProcess {
    this.reapExpired();
    const active = [...this.entries.values()]
      .filter((entry) => entry.record.status === 'running').length;
    if (active >= MAX_ACTIVE_PROCESSES) {
      throw new ProcessRegistryError(
        'too_many_processes',
        `Too many background processes (${MAX_ACTIVE_PROCESSES.toString()}).`
        + ' Terminate one before starting another.',
      );
    }

    const processId = randomUUID();
    // A handle can arrive already finished: the process may exit between
    // yielding and being adopted. Reporting it as running would be a lie the
    // caller acts on.
    const alreadyExited = params.handle.hasExited;
    const record: ManagedProcess = {
      processId,
      owner: params.owner,
      command: params.command,
      cwd: params.cwd,
      pid: params.handle.pid,
      startedAt: Date.now(),
      status: alreadyExited ? 'exited' : 'running',
      exitCode: null,
      exitedAt: alreadyExited ? Date.now() : null,
    };

    const entry: Entry = {
      record,
      handle: params.handle,
      // Output captured before the handover still belongs to the owner,
      // unless the caller has already shown it.
      pendingStdout: params.outputAlreadyDelivered ? '' : params.handle.stdout,
      pendingStderr: params.outputAlreadyDelivered ? '' : params.handle.stderr,
      unsubscribe: () => undefined,
      lock: Promise.resolve(),
    };
    entry.unsubscribe = params.handle.onOutput((stream, chunk) => {
      if (stream === 'stdout') entry.pendingStdout += chunk;
      else entry.pendingStderr += chunk;
    });
    this.entries.set(processId, entry);

    void params.handle.wait().then((exit) => {
      void this.withLock(entry, () => {
        if (record.status === 'running') {
          record.status = 'exited';
        }
        record.exitCode = exit.code;
        record.exitedAt = Date.now();
        entry.unsubscribe();
      });
    });

    return { ...record };
  }

  /**
   * Remember a process group that survived its command so shutdown can still
   * clean it up.
   *
   * A command may exit successfully having left work behind — `npm run dev &`
   * is the ordinary case. Those children stay in the original group even
   * though its leader is gone, so the group id remains a precise handle on
   * exactly what that command started.
   */
  trackOrphanGroup(pid: number) {
    if (!this.executor.isGroupAlive(pid)) return false;
    this.orphanGroups.add(pid);
    return true;
  }

  list(owner: ManagedProcessOwner): ProcessSnapshot[] {
    this.reapExpired();
    return [...this.entries.values()]
      .filter((entry) => sameOwner(entry.record.owner, owner))
      .map((entry) => ({ ...entry.record }));
  }

  /**
   * Take everything buffered since the last drain.
   *
   * Draining is destructive so repeated waits do not re-deliver the whole
   * history; each chunk reaches the caller exactly once.
   */
  async drain(processId: string, owner: ManagedProcessOwner): Promise<DrainResult> {
    const entry = this.require(processId, owner);
    return await this.withLock(entry, () => {
      const stdout = entry.pendingStdout;
      const stderr = entry.pendingStderr;
      entry.pendingStdout = '';
      entry.pendingStderr = '';
      return { process: { ...entry.record }, stdout, stderr };
    });
  }

  /** Wait for exit, or return the current state once `timeoutMs` elapses. */
  async wait(
    processId: string,
    owner: ManagedProcessOwner,
    timeoutMs: number,
  ): Promise<DrainResult> {
    const entry = this.require(processId, owner);
    if (entry.record.status === 'running') {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        entry.handle.wait(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    return await this.drain(processId, owner);
  }

  async terminate(
    processId: string,
    owner: ManagedProcessOwner,
    killGraceMs?: number,
  ): Promise<ProcessSnapshot> {
    const entry = this.require(processId, owner);
    return await this.withLock(entry, async () => {
      if (entry.record.status === 'running') {
        entry.record.status = 'terminated';
        entry.handle.terminate(killGraceMs);
        await entry.handle.wait();
        entry.record.exitedAt = Date.now();
      }
      return { ...entry.record };
    });
  }

  /**
   * Terminate everything this registry knows about.
   *
   * Called from the Toolkit runtime's `stop`, so host shutdown does not strand
   * processes started on its behalf.
   */
  async stopAll(killGraceMs?: number) {
    const running = [...this.entries.values()]
      .filter((entry) => entry.record.status === 'running');
    await Promise.all(running.map(async (entry) => {
      entry.record.status = 'terminated';
      entry.handle.terminate(killGraceMs);
      await entry.handle.wait();
      entry.record.exitedAt = Date.now();
    }));
    for (const entry of this.entries.values()) entry.unsubscribe();
    this.entries.clear();

    for (const pid of this.orphanGroups) {
      // Unlike a managed process, nothing here has been holding this group
      // open, so its id could since have been recycled by an unrelated
      // process. Only signal a group that is still alive, and accept that the
      // check is advisory — this narrows the window rather than closing it.
      if (this.executor.isGroupAlive(pid)) {
        this.executor.terminateGroup(pid, ORPHAN_GROUP_KILL_GRACE_MS);
      }
    }
    this.orphanGroups.clear();
  }

  private require(processId: string, owner: ManagedProcessOwner): Entry {
    const entry = this.entries.get(processId);
    if (!entry) {
      throw new ProcessRegistryError(
        'unknown_process',
        `No such process: ${processId}. It may have already been reaped.`,
      );
    }
    if (!sameOwner(entry.record.owner, owner)) {
      throw new ProcessRegistryError(
        'not_owner',
        `Process ${processId} belongs to a different execution.`,
      );
    }
    return entry;
  }

  private withLock<T>(entry: Entry, operation: () => T | Promise<T>): Promise<T> {
    const result = entry.lock.then(operation);
    entry.lock = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Drop finished processes past their TTL.
   *
   * A finished process stays readable for a while so its owner can collect the
   * last of the output; a running one is never reaped, however old.
   */
  private reapExpired() {
    const cutoff = Date.now() - EXITED_PROCESS_TTL_MS;
    for (const [processId, entry] of this.entries) {
      if (entry.record.status === 'running') continue;
      if (entry.record.exitedAt !== null && entry.record.exitedAt <= cutoff) {
        entry.unsubscribe();
        this.entries.delete(processId);
      }
    }
  }
}
