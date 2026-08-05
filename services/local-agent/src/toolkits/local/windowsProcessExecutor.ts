import { spawn } from 'node:child_process';
import type {
  ProcessExecutor,
  ShellRunHandle,
  ShellRunOptions,
  ShellRunOutcome,
} from './processExecutor';

/**
 * Windows implementation of {@link ProcessExecutor} (#562).
 *
 * Windows has no process groups and no POSIX signals, so the two primitives
 * the POSIX executor builds on — `kill(-pid, sig)` and signal 0 — do not
 * exist. The equivalents used here are:
 *
 * - **Terminate**: `taskkill /PID <pid> /T /F`. `/T` walks the child tree, so
 *   a command that forked (`npm run dev`) loses its descendants with it. It
 *   cannot find children orphaned before the kill — a parent that already
 *   exited leaves nothing for `/T` to anchor on — which is the documented
 *   degradation versus a job object. A job object would close that gap but
 *   needs a native module, and this runtime has a zero-native-dependency
 *   constraint.
 *
 * - **Liveness probe**: there is no signal 0, and without a native module
 *   there is no OpenProcess either. `isGroupAlive` is therefore conservative:
 *   it reports alive unless the caller's own bookkeeping says otherwise.
 *   Callers treat the answer as advisory, which the interface already
 *   promises ("best-effort").
 *
 * - **Shell**: PowerShell with `-NoLogo -NoProfile -NonInteractive -Command`.
 *   `cmd.exe` is avoided because its parsing of quotes, redirection and
 *   special characters differs enough from POSIX `sh` to surprise callers;
 *   PowerShell is the modern Windows automation shell and ships with the OS.
 *
 * Graceful-then-forceful escalation does not translate: `taskkill /F` is the
 * only reliable termination available without native code, so `terminateGroup`
 * ignores the grace period. The run-level `terminate` still honours its own
 * timeout/abort semantics; only the OS-level kill is unconditional.
 */

/**
 * Floor for how long a Windows command runs before it may yield.
 *
 * Process creation on Windows is markedly slower than on POSIX (no fork;
 * CreateProcess plus PowerShell startup), so a timeout tuned for POSIX yields
 * commands that were merely still starting. Codex observed the same and set a
 * separate, higher floor for Windows; 10s matches that.
 */
export const WINDOWS_EXEC_YIELD_FLOOR_MS = 10_000;

/**
 * Which PowerShell to run commands through.
 *
 * `powershell.exe` (Windows PowerShell) ships with the OS, whereas `pwsh`
 * (PowerShell Core) is an optional install, so the built-in one is the only
 * safe default. It is resolved from PATH rather than by absolute path, which
 * keeps this working under a non-standard system root.
 *
 * `PINPAWO_WINDOWS_SHELL` overrides it for anyone who does want `pwsh` or a
 * specific build. Note this is not `ComSpec`: that variable names the *command
 * interpreter* — conventionally `cmd.exe` — so reading it here would either
 * never match or hand back a shell whose quoting rules these commands are not
 * written for.
 */
export function windowsPowerShellPath() {
  const override = process.env.PINPAWO_WINDOWS_SHELL?.trim();
  return override || 'powershell.exe';
}

function terminateTree(pid: number) {
  try {
    // taskkill exits non-zero when the pid is already gone; that is the
    // normal race, not a failure worth surfacing.
    const child = spawn('taskkill', ['/PID', pid.toString(), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Nothing better to do: the process may already be gone.
  }
}

export function runShellCommandWindows(
  options: ShellRunOptions,
): Promise<ShellRunOutcome> {
  const {
    command,
    cwd,
    maxOutputChars,
    signal,
    // `killGraceMs` is deliberately not read: `taskkill /F` is the only
    // reliable termination available without native code, so there is no
    // graceful phase to wait through.
    yieldOnTimeout = false,
  } = options;

  // Windows process startup is slow; never yield sooner than the floor.
  const timeoutMs = yieldOnTimeout
    ? Math.max(options.timeoutMs, WINDOWS_EXEC_YIELD_FLOOR_MS)
    : options.timeoutMs;

  return new Promise<ShellRunOutcome>((resolve) => {
    if (signal?.aborted) {
      resolve({ status: 'aborted', stdout: '', stderr: '' });
      return;
    }

    let child;
    try {
      child = spawn(
        windowsPowerShellPath(),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
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

    const terminateGroup = () => {
      if (pid === undefined) return;
      terminateTree(pid);
    };

    const terminate = (why: 'timeout' | 'aborted') => {
      if (settled || reason) return;
      reason = why;
      terminateGroup();
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
        terminate: () => {
          if (exited) return;
          terminateGroup();
        },
      };
      settle({ status: 'yielded', handle });
    }

    child.on('error', (err) => {
      if (yielded) {
        exited = true;
        resolveExit({ code: null, stdout, stderr });
        return;
      }
      settle({ status: 'spawn_failed', error: err });
    });

    child.on('close', (code) => {
      exited = true;
      if (yielded) {
        resolveExit({ code, stdout, stderr });
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

/**
 * Best-effort liveness probe.
 *
 * Without a native module there is no OpenProcess on Windows, so this cannot
 * distinguish a live process from a recycled pid. Reporting alive is the
 * conservative choice: the only consumer is orphan-group cleanup, where a
 * false positive sends one harmless `taskkill` at a pid that turns out to be
 * gone, whereas a false negative would leak the group.
 */
function isGroupAliveBestEffort(_pid: number) {
  return true;
}

function terminateGroupWindows(pid: number, _graceMs: number) {
  // No graceful phase exists without native code: taskkill /F is the only
  // reliable kill, so the grace period does not apply.
  terminateTree(pid);
}

export const windowsProcessExecutor: ProcessExecutor = {
  run: runShellCommandWindows,
  terminateGroup: terminateGroupWindows,
  isGroupAlive: isGroupAliveBestEffort,
};
