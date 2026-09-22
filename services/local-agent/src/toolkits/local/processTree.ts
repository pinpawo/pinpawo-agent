import { spawn } from 'node:child_process';
import type {
  ProcessExecutor,
  ShellRunHandle,
  ShellRunOptions,
  ShellRunOutcome,
} from './processExecutor';

/**
 * POSIX implementation of {@link ProcessExecutor}.
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
 */


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
      const executable = options.executable ?? options.shell;
      if (!executable) throw new Error('The Shell environment must select an executable.');
      child = spawn(executable, options.executable ? [...(options.args ?? [])] : ['-c', command], {
        cwd,
        env: options.env,
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
    let stdoutTotalChars = 0;
    let stderrTotalChars = 0;
    let settled = false;
    let yielded = false;
    let exited = false;
    let reason: 'timeout' | 'aborted' | 'output_limit' | null = null;
    let termination: Promise<void> | null = null;

    const outputListeners = new Set<
      (stream: 'stdout' | 'stderr', chunk: string) => void
    >();
    let resolveExit!: (value: {
      code: number | null;
      stdout: string;
      stderr: string;
    }) => void;
    let rejectExit!: (error: Error) => void;
    const exitPromise = new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((r, reject) => { resolveExit = r; rejectExit = reject; });

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
      stdoutTotalChars += chunk.length;
      if (stdout.length < maxOutputChars) {
        stdout += chunk.slice(0, maxOutputChars - stdout.length);
      }
      if (options.failOnOutputLimit && stdoutTotalChars > maxOutputChars) terminate('output_limit');
    });
    collect(child.stderr, 'stderr', (chunk) => {
      stderrTotalChars += chunk.length;
      if (stderr.length < maxOutputChars) {
        stderr += chunk.slice(0, maxOutputChars - stderr.length);
      }
      if (options.failOnOutputLimit && stderrTotalChars > maxOutputChars) terminate('output_limit');
    });

    const terminateGroup = (grace: number) => {
      if (pid === undefined || termination) return;
      termination = terminateProcessGroup(pid, grace);
      // The close handler reports a cleanup failure after consuming this promise.
      void termination.catch(() => undefined);
    };

    const terminate = (why: 'timeout' | 'aborted' | 'output_limit') => {
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

    child.on('close', async (code) => {
      exited = true;
      // A completed shell may leave redirected background children. They have
      // no returned process handle, so clean them now, never retain an exited
      // PGID for a later client disconnect when the number could be reused.
      if (!termination && pid !== undefined && isProcessGroupAlive(pid)) {
        terminateGroup(killGraceMs);
      }
      // The direct child can close its pipes before descendants finish. Keep
      // the escalation alive and confirm the group before reporting completion.
      if (termination) {
        try { await termination; } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          if (yielded) rejectExit(failure);
          else settle({ status: 'spawn_failed', error: failure });
          return;
        }
      }
      if (yielded) {
        resolveExit({ code, stdout, stderr });
        // Nothing more will be emitted; do not keep subscriber closures alive
        // for as long as the handle is retained.
        outputListeners.clear();
        return;
      }
      if (reason === 'timeout' || reason === 'output_limit') {
        settle({ status: reason, stdout, stderr, stdoutTotalChars, stderrTotalChars });
        return;
      }
      if (reason === 'aborted') {
        settle({ status: 'aborted', stdout, stderr });
        return;
      }
      settle({ status: 'exited', code, pid, stdout, stderr, stdoutTotalChars, stderrTotalChars });
    });
  });
}

/** Probe whether any member of a process group is still alive. */
export function isProcessGroupAlive(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the group exists but is no longer ours to signal.
    return code === 'EPERM';
  }
}

/**
 * Terminate a process group, escalating if it does not go quietly.
 *
 * The operation completes only when the group disappears. A direct child's
 * close event alone cannot confirm descendant cleanup. Timers stop once the
 * group is gone; failure to confirm cleanup is surfaced to the caller.
 */
function terminateProcessGroup(pid: number, graceMs: number): Promise<void> {
  killProcessGroup(pid, 'SIGTERM');
  if (!isProcessGroupAlive(pid)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + Math.max(0, graceMs) + 1000;
    const escalation = setTimeout(() => {
      if (isProcessGroupAlive(pid)) killProcessGroup(pid, 'SIGKILL');
    }, Math.max(0, graceMs));
    const poll = setInterval(() => {
      const alive = isProcessGroupAlive(pid);
      if (alive && Date.now() < deadline) return;
      clearTimeout(escalation);
      clearInterval(poll);
      if (alive) reject(new Error(`Process group ${pid} cleanup could not be confirmed.`));
      else resolve();
    }, 20);
  });
}

export const posixProcessExecutor: ProcessExecutor = {
  run: runShellCommand,
};
