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
 * the child's pid. Signals reach members of that group; descendants that
 * deliberately leave it are outside this executor's containment boundary.
 */


const DEFAULT_KILL_GRACE_MS = 2_000;

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

async function terminateAndConfirmGroup(pid: number, graceMs: number): Promise<boolean> {
  killProcessGroup(pid, 'SIGTERM');
  if (await waitForGroupExit(pid, graceMs)) return true;
  killProcessGroup(pid, 'SIGKILL');
  return await waitForGroupExit(pid, 1_000);
}

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
    env,
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
      const [file, args] = typeof command === 'string'
        ? ['/bin/sh', ['-c', command]]
        : [command.argv[0], command.argv.slice(1)];
      child = spawn(file, args, {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(env ? { env: { ...process.env, ...env } } : {}),
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
    let finished = false;
    let exitCode: number | null = null;
    let closed = false;
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
    let reason: 'timeout' | 'aborted' | null = null;
    let groupTermination: Promise<boolean> | null = null;

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
      // Keep cleaning up even when the leader closes its output before its
      // children exit. A close event alone does not confirm group termination.
      if (groupTermination) return;
      groupTermination = terminateAndConfirmGroup(pid, grace).catch(() => false);
      void groupTermination.then(async (groupGone) => {
        // Allow queued EOF/close events to drain, but never let an escaped
        // descendant holding a pipe keep timeout, cancellation or stop pending.
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          closedPromise,
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 100); }),
        ]);
        if (timer) clearTimeout(timer);
        const confirmed = groupGone && closed;
        if (!closed) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
        }
        if (yielded) {
          finishManaged();
        } else if (reason === 'timeout') {
          settle({ status: 'timeout', pid, termination: confirmed ? 'confirmed' : 'unconfirmed', stdout, stderr });
        } else if (reason === 'aborted') {
          settle({ status: 'aborted', stdout, stderr });
        }
      });
    };

    const terminate = (why: 'timeout' | 'aborted') => {
      if (settled || reason) return;
      reason = why;
      terminateGroup(killGraceMs);
    };

    const timeoutTimer = yieldOnTimeout && timeoutMs === 0 ? undefined : setTimeout(() => {
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
          if (finished) return;
          terminateGroup(grace);
        },
      };
      settle({ status: 'yielded', handle });
    }

    // Immediate managed starts must have a handle even if the program exits
    // before a zero-delay timer would fire. Spawn errors still reject startup.
    child.once('spawn', () => {
      if (yieldOnTimeout && timeoutMs === 0) yieldOwnership();
    });

    child.on('error', (err) => {
      if (yielded) {
        // The handle owns the outcome now; a late spawn error simply ends it.
        exited = true;
        resolveExit({ code: null, stdout, stderr });
        return;
      }
      settle({ status: 'spawn_failed', error: err });
    });

    function finishManaged() {
      if (finished) return;
      finished = true;
      resolveExit({ code: exitCode, stdout, stderr });
      outputListeners.clear();
    }

    // Process exit and pipe closure are separate facts. Do not delay this
    // flag while waiting for descendants or for the termination grace period.
    child.once('exit', (code) => {
      exited = true;
      exitCode = code;
    });

    child.on('close', (code) => {
      closed = true;
      exited = true;
      exitCode = code;
      resolveClosed();
      // The bounded termination path owns completion, including pipe cleanup.
      if (groupTermination) return;
      if (yielded) {
        finishManaged();
        return;
      }
      settle({ status: 'exited', code, pid, stdout, stderr });
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
 * The forceful follow-up is unref'd: it must not hold the event loop open
 * merely to escalate a kill.
 *
 * Managed calls use terminateAndConfirmGroup and await a bounded confirmation
 * path. This fallback is for orphan groups with no live handle; it schedules
 * a best-effort escalation without keeping the service alive. Group IDs can
 * be reused, so probing liveness does not prove ownership of a recycled ID.
 */
function terminateProcessGroup(pid: number, graceMs: number) {
  killProcessGroup(pid, 'SIGTERM');
  const timer = setTimeout(() => {
    killProcessGroup(pid, 'SIGKILL');
  }, graceMs);
  timer.unref?.();
}

export const posixProcessExecutor: ProcessExecutor = {
  run: runShellCommand,
  terminateGroup: terminateProcessGroup,
  isGroupAlive: isProcessGroupAlive,
};
