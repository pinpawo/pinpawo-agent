import { spawn } from 'node:child_process';

/**
 * Run a shell command as its own process group so it can be terminated whole.
 *
 * `execFile`'s `timeout` only signals the direct child. For a command that
 * forks — `pnpm install`, a build, a test runner — that kills the `/bin/sh`
 * wrapper and leaves the real work running, reparented to init. The tool then
 * reports "timed out" while the command is in fact still going, so the model
 * sees a failure where there is an ongoing process, and a retry runs a second
 * copy concurrently.
 *
 * Spawning detached puts the command in a new process group whose id equals
 * the child's pid, so `kill(-pid)` reaches every descendant.
 *
 * This is the bounded-command path only: it always waits for exit. Long-running
 * process handles are #513's job, and that runtime is expected to reuse this
 * process-group handling.
 */

/**
 * Ownership of a still-running process, handed over when the caller yields
 * instead of waiting.
 *
 * Yielding detaches the run from the call that started it: the abort listener
 * and the timeout are cleared, so a later cancellation of that call can no
 * longer kill the process. Whoever takes the handle owns termination from then
 * on.
 */
export type ShellRunHandle = {
  pid: number;
  /** Everything captured so far, including output produced after the yield. */
  stdout: string;
  stderr: string;
  /**
   * Whether the process has already finished.
   *
   * A handle can be taken over after its process exited — the gap between
   * yielding and being adopted is enough — so an owner needs to tell a live
   * process from a finished one without waiting on it.
   */
  hasExited: boolean;
  /**
   * Subscribe to output produced after the yield; returns an unsubscribe
   * function. Output also keeps accumulating into `stdout`/`stderr` under the
   * same caps whether or not anyone subscribes.
   */
  onOutput: (
    listener: (stream: 'stdout' | 'stderr', chunk: string) => void,
  ) => () => void;
  /** Resolves once the process exits on its own or is terminated. */
  wait: () => Promise<{ code: number | null; stdout: string; stderr: string }>;
  terminate: (killGraceMs?: number) => void;
};

export type ShellRunOutcome =
  /**
   * `pid` doubles as the process group id. A command can exit cleanly having
   * left background children behind (`npm run dev &`); those stay in the
   * original group even though its leader is gone, so the caller can still use
   * this to find and clean them up.
   */
  | { status: 'exited'; code: number | null; pid: number | undefined; stdout: string; stderr: string }
  | { status: 'timeout'; stdout: string; stderr: string }
  | { status: 'aborted'; stdout: string; stderr: string }
  | { status: 'spawn_failed'; error: Error }
  | { status: 'yielded'; handle: ShellRunHandle };

export type ShellRunOptions = {
  command: string;
  cwd: string;
  timeoutMs: number;
  /**
   * Cap on captured characters per stream. Counted in characters, not bytes,
   * so it stays consistent with the character-based truncation applied to the
   * result; the byte cost of multi-byte output is a small multiple of this.
   */
  maxOutputChars: number;
  signal?: AbortSignal;
  /** Grace period between SIGTERM and SIGKILL for the process group. */
  killGraceMs?: number;
  /**
   * Hand back a handle instead of terminating when `timeoutMs` elapses.
   *
   * A timeout means the command is slow, not that it failed; killing it loses
   * work and, because the caller reads that as failure, invites a concurrent
   * retry. Yielding lets the run continue under new ownership.
   */
  yieldOnTimeout?: boolean;
};

const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * Signal a whole process group, tolerating a group that is already gone.
 *
 * Returns false when the group no longer exists, which is the normal race
 * between deciding to kill and the process exiting on its own.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM means the group outlived our permission to signal it; there is
    // nothing better to do than report it as not killed.
    if (code === 'EPERM') return false;
    throw err;
  }
}

export function runShellCommand(options: ShellRunOptions): Promise<ShellRunOutcome> {
  const {
    command,
    cwd,
    timeoutMs,
    maxOutputChars,
    signal,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    yieldOnTimeout = false,
  } = options;

  return new Promise<ShellRunOutcome>((resolve) => {
    if (signal?.aborted) {
      resolve({ status: 'aborted', stdout: '', stderr: '' });
      return;
    }

    let child;
    try {
      child = spawn('/bin/sh', ['-c', command], {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        status: 'spawn_failed',
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    const pid = child.pid;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let yielded = false;
    let exited = false;
    let reason: 'timeout' | 'aborted' | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const outputListeners = new Set<
      (stream: 'stdout' | 'stderr', chunk: string) => void
    >();
    let resolveExit!: (value: {
      code: number | null;
      stdout: string;
      stderr: string;
    }) => void;
    const exitPromise = new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((r) => { resolveExit = r; });

    const collect = (
      stream: NodeJS.ReadableStream | null,
      name: 'stdout' | 'stderr',
      append: (chunk: string) => void,
    ) => {
      if (!stream) return;
      stream.setEncoding('utf-8');
      stream.on('data', (chunk: string) => {
        append(chunk);
        for (const listener of outputListeners) listener(name, chunk);
      });
    };

    collect(child.stdout, 'stdout', (chunk) => {
      if (stdout.length < maxOutputChars) {
        stdout += chunk.slice(0, maxOutputChars - stdout.length);
      }
    });
    collect(child.stderr, 'stderr', (chunk) => {
      if (stderr.length < maxOutputChars) {
        stderr += chunk.slice(0, maxOutputChars - stderr.length);
      }
    });

    const terminateGroup = (grace: number) => {
      if (pid === undefined) return;
      killProcessGroup(pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        killProcessGroup(pid, 'SIGKILL');
      }, grace);
      // Do not hold the event loop open just to escalate a kill.
      killTimer.unref?.();
    };

    const terminate = (why: 'timeout' | 'aborted') => {
      if (settled || reason) return;
      reason = why;
      terminateGroup(killGraceMs);
    };

    const timeoutTimer = setTimeout(() => {
      if (yieldOnTimeout) {
        yieldOwnership();
        return;
      }
      terminate('timeout');
    }, timeoutMs);
    const onAbort = () => terminate('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const settle = (outcome: ShellRunOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    /**
     * Detach the run from this call and resolve with a handle.
     *
     * `cleanup()` is what makes the handover safe: it removes the abort
     * listener so a later cancellation of the originating tool call cannot
     * kill a process that has outlived it, and clears the timeout that has
     * already fired.
     */
    function yieldOwnership() {
      if (settled || reason || pid === undefined) return;
      yielded = true;
      cleanup();

      const handle: ShellRunHandle = {
        pid,
        get stdout() { return stdout; },
        get stderr() { return stderr; },
        get hasExited() { return exited; },
        onOutput: (listener) => {
          outputListeners.add(listener);
          return () => outputListeners.delete(listener);
        },
        wait: () => exitPromise,
        terminate: (grace = killGraceMs) => {
          if (exited) return;
          terminateGroup(grace);
        },
      };
      settle({ status: 'yielded', handle });
    }

    child.on('error', (err) => {
      if (yielded) {
        // The handle owns the outcome now; a late spawn error simply ends it.
        exited = true;
        resolveExit({ code: null, stdout, stderr });
        return;
      }
      settle({ status: 'spawn_failed', error: err });
    });

    child.on('close', (code) => {
      exited = true;
      if (yielded) {
        if (killTimer) clearTimeout(killTimer);
        resolveExit({ code, stdout, stderr });
        // Nothing more will be emitted; do not keep subscriber closures alive
        // for as long as the handle is retained.
        outputListeners.clear();
        return;
      }
      if (reason === 'timeout') {
        settle({ status: 'timeout', stdout, stderr });
        return;
      }
      if (reason === 'aborted') {
        settle({ status: 'aborted', stdout, stderr });
        return;
      }
      settle({ status: 'exited', code, pid, stdout, stderr });
    });
  });
}
