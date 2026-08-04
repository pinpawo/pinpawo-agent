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

export type ShellRunOutcome =
  | { status: 'exited'; code: number | null; stdout: string; stderr: string }
  | { status: 'timeout'; stdout: string; stderr: string }
  | { status: 'aborted'; stdout: string; stderr: string }
  | { status: 'spawn_failed'; error: Error };

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
    let reason: 'timeout' | 'aborted' | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const collect = (
      stream: NodeJS.ReadableStream | null,
      append: (chunk: string) => void,
    ) => {
      if (!stream) return;
      stream.setEncoding('utf-8');
      stream.on('data', (chunk: string) => append(chunk));
    };

    collect(child.stdout, (chunk) => {
      if (stdout.length < maxOutputChars) {
        stdout += chunk.slice(0, maxOutputChars - stdout.length);
      }
    });
    collect(child.stderr, (chunk) => {
      if (stderr.length < maxOutputChars) {
        stderr += chunk.slice(0, maxOutputChars - stderr.length);
      }
    });

    const terminate = (why: 'timeout' | 'aborted') => {
      if (settled || reason) return;
      reason = why;
      if (pid === undefined) return;
      killProcessGroup(pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        killProcessGroup(pid, 'SIGKILL');
      }, killGraceMs);
      // Do not hold the event loop open just to escalate a kill.
      killTimer.unref?.();
    };

    const timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs);
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

    child.on('error', (err) => {
      settle({ status: 'spawn_failed', error: err });
    });

    child.on('close', (code) => {
      if (reason === 'timeout') {
        settle({ status: 'timeout', stdout, stderr });
        return;
      }
      if (reason === 'aborted') {
        settle({ status: 'aborted', stdout, stderr });
        return;
      }
      settle({ status: 'exited', code, stdout, stderr });
    });
  });
}
