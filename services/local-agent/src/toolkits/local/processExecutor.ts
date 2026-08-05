/**
 * The contract between process ownership and the OS that provides it.
 *
 * Everything above this line — the registry's ownership, quota, buffering and
 * lifecycle — is the same on any platform. Everything below it is not: process
 * groups and signals are POSIX, and Windows reaches the same outcomes through
 * job objects or `taskkill`.
 *
 * The methods therefore name intent, not mechanism. `terminateGroup` means
 * "end this command and everything it started", which each platform answers in
 * its own way. That is what lets Windows arrive as an additional
 * implementation rather than a fork of the working one (#562).
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
  /**
   * End a command and everything it started.
   *
   * Graceful first, forceful after `graceMs`.
   */
  terminateGroup: (pid: number, graceMs: number) => void;
  /**
   * Whether any member of the command's process tree is still running.
   *
   * Best-effort: a caller can only learn that the tree was alive at the moment
   * of the check.
   */
  isGroupAlive: (pid: number) => boolean;
};
