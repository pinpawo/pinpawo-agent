/**
 * The contract between process ownership and the OS that provides it.
 *
 * Everything above this line — the registry's ownership, quota, buffering and
 * lifecycle — is the same on any platform. Everything below it is not: process
 * groups and signals are POSIX, and Windows reaches the same outcomes through
 * job objects or `taskkill`.
 *
 * The platform returns an owned handle for yielded work. Callers terminate
 * through that handle; completed numeric PIDs are never retained for reuse.
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
  /**
   * Identifies the command's whole process tree, not just its direct child.
   *
   * On POSIX this is the process group id, which stays valid even after the
   * leader exits — that is what lets a command's background children still be
   * found once the command itself is gone.
   */
  pid: number;
  /** Everything captured so far, including output produced after the yield. */
  stdout: string;
  stderr: string;
  /**
   * Whether the process has finished and platform cleanup has succeeded.
   *
   * A handle can be taken over after its process exited — the gap between
   * yielding and being adopted is enough — so an owner needs to tell a live
   * process from a finished one without waiting on it. Pending or failed
   * cleanup must remain false so owners still observe wait()'s outcome.
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
  /** POSIX reclaims unhandled descendants before reporting an exited command. */
  | { status: 'exited'; code: number | null; pid: number | undefined; stdout: string; stderr: string; stdoutTotalChars?: number; stderrTotalChars?: number }
  | { status: 'timeout' | 'output_limit'; stdout: string; stderr: string; stdoutTotalChars?: number; stderrTotalChars?: number }
  | { status: 'aborted'; stdout: string; stderr: string; stdoutTotalChars?: number; stderrTotalChars?: number }
  | { status: 'spawn_failed'; error: Error }
  | { status: 'yielded'; handle: ShellRunHandle };

export type ShellRunOptions = {
  command: string;
  cwd: string;
  /** Fixed by the service-owned environment, never inherited at spawn time. */
  env: NodeJS.ProcessEnv;
  shell?: string;
  /** An argv invocation bypasses the shell entirely. */
  executable?: string;
  args?: readonly string[];
  timeoutMs: number;
  /**
   * Cap on captured characters per stream. Counted in characters, not bytes,
   * so it stays consistent with the character-based truncation applied to the
   * result; the byte cost of multi-byte output is a small multiple of this.
   */
  maxOutputChars: number;
  /** Stop immediately on overflow (e.g. Git output); otherwise keep bounded output. */
  failOnOutputLimit?: boolean;
  signal?: AbortSignal;
  /** Grace period before a termination is escalated to a forceful one. */
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

export type ProcessExecutor = {
  /** Start a command and resolve once it settles, times out, or yields. */
  run: (options: ShellRunOptions) => Promise<ShellRunOutcome>;
};
