import { randomUUID } from 'node:crypto';
import type { DelegationScope } from '@pinpawo/pet-agent';
import type { ShellRunHandle } from './processExecutor';

/**
 * Session-lifetime registry for shell processes that outlive the tool call
 * that started them.
 *
 * A timed-out command is slow, not failed. #554 lets such a command hand back
 * a handle instead of being killed; this registry is what holds that handle so
 * the model can wait on it, read from it, or terminate it later, and so host
 * shutdown can clean up whatever is still running.
 *
 * One service-owned Shell environment holds the registry. Access includes
 * client, Toolkit and execution identity; ending a Tool call does not kill
 * yielded work, while disconnecting its client does.
 */

export type ManagedProcessStatus =
  | 'running'
  | 'exited'
  | 'terminated';

export type ManagedProcessOwner = Pick<
  DelegationScope,
  'threadId' | 'taskId' | 'runId' | 'delegationId'
> & { clientId: string; toolkitName: string };

export type ManagedProcess = {
  processId: string;
  owner: ManagedProcessOwner;
  command: string;
  cwd: string;
  startedAt: number;
  status: ManagedProcessStatus;
  exitCode: number | null;
  exitedAt: number | null;
};

export type ProcessSnapshot = Omit<ManagedProcess, never>;

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

function sameOwner(left: ManagedProcessOwner, right: ManagedProcessOwner) {
  return left.clientId === right.clientId
    && left.toolkitName === right.toolkitName
    && left.threadId === right.threadId
    && left.taskId === right.taskId
    && left.runId === right.runId
    && left.delegationId === right.delegationId;
}

type Entry = {
  record: ManagedProcess;
  handle: ShellRunHandle;
  /** Output not yet drained by the owner. */
  pendingStdout: string;
  pendingStderr: string;
  omittedStdout: number;
  omittedStderr: number;
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

  get size() {
    return this.entries.size;
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
      omittedStdout: 0,
      omittedStderr: 0,
      unsubscribe: () => undefined,
      lock: Promise.resolve(),
    };
    entry.unsubscribe = params.handle.onOutput((stream, chunk) => {
      const limit = 4 * 1024 * 1024;
      if (stream === 'stdout') {
        const kept = chunk.slice(0, Math.max(0, limit - entry.pendingStdout.length));
        entry.pendingStdout += kept;
        entry.omittedStdout += chunk.length - kept.length;
      } else {
        const kept = chunk.slice(0, Math.max(0, limit - entry.pendingStderr.length));
        entry.pendingStderr += kept;
        entry.omittedStderr += chunk.length - kept.length;
      }
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
    }, () => { entry.unsubscribe(); });

    return { ...record };
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
      const stdout = entry.pendingStdout + (entry.omittedStdout ? `\n[truncated ${entry.omittedStdout} chars]` : '');
      const stderr = entry.pendingStderr + (entry.omittedStderr ? `\n[truncated ${entry.omittedStderr} chars]` : '');
      entry.pendingStdout = '';
      entry.pendingStderr = '';
      entry.omittedStdout = 0;
      entry.omittedStderr = 0;
      return { process: { ...entry.record }, stdout, stderr };
    });
  }

  /** Wait for exit, or return the current state once `timeoutMs` elapses. */
  async wait(
    processId: string,
    owner: ManagedProcessOwner,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DrainResult> {
    const entry = this.require(processId, owner);
    if (entry.record.status === 'running') {
      let timer: NodeJS.Timeout | undefined;
      let abort: (() => void) | undefined;
      if (signal?.aborted) throw Object.assign(new Error('Process wait aborted'), { name: 'AbortError' });
      try { await Promise.race([
        entry.handle.wait(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(Object.assign(new Error('Process wait aborted'), { name: 'AbortError' }));
          signal?.addEventListener('abort', abort, { once: true });
        }),
      ]); } finally {
        if (timer) clearTimeout(timer);
        if (abort) signal?.removeEventListener('abort', abort);
      }
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
        entry.handle.terminate(killGraceMs);
        await entry.handle.wait();
        entry.record.status = 'terminated';
        entry.record.exitedAt = Date.now();
      }
      return { ...entry.record };
    });
  }

  /**
   * Terminate everything this registry knows about.
   *
   * Called when the service shuts down its environment.
   */
  async stopAll(killGraceMs?: number) {
    await this.stopMatching(() => true, killGraceMs);
  }

  async stopClient(clientId: string, killGraceMs?: number) {
    await this.stopMatching((owner) => owner.clientId === clientId, killGraceMs);
  }

  private async stopMatching(matches: (owner: ManagedProcessOwner) => boolean, killGraceMs?: number) {
    const running = [...this.entries.values()]
      .filter((entry) => matches(entry.record.owner) && entry.record.status === 'running');
    await Promise.all(running.map(async (entry) => {
      entry.handle.terminate(killGraceMs);
      await entry.handle.wait();
      entry.record.status = 'terminated';
      entry.record.exitedAt = Date.now();
    }));
    for (const [id, entry] of this.entries) {
      if (!matches(entry.record.owner)) continue;
      entry.unsubscribe();
      this.entries.delete(id);
    }

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
