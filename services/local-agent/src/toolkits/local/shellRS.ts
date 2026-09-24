import type {
  ToolkitRS,
  ToolkitRSRequirement,
} from '@pinpawo/pet-agent';

/**
 * ShellRS: the shell/CLI execution contract that shell-dependent Toolkits
 * (bash, git, project-inspection) are written against.
 *
 * The contract names shell semantics, not a platform. `PosixShellRS` is the
 * only implementation today; a Windows implementation must satisfy the same
 * interface and the same observable Tool behavior — including shell-string
 * syntax and argv handling — rather than handing POSIX commands to PowerShell.
 *
 * One Agent session maps to one ShellRS logical session. The logical session
 * holds the commands that session started, their output and their process
 * handles. Kernel sessions, process groups and (later) PTYs are resources of an
 * implementation and never stand in for the Agent session id, which the RS
 * treats as opaque.
 *
 * Reserved, not implemented in this phase:
 * - an interactive PTY per logical session (input, output, terminal size and
 *   close all managed by the RS). Commands today run over pipes as independent
 *   processes; nothing here is a persistent interactive shell, and a command
 *   does not inherit a previous command's `cd` or `export`.
 * - explicitly managed processes that return a handle immediately. `exec` with
 *   `onTimeout: 'yield'` and `waitMs: 0` is the closest current behavior.
 */

export const SHELL_RS_CONTRACT = 'pinpawo.shell-rs';
export const SHELL_RS_VERSION = 1;

export const SHELL_RS_REQUIREMENT: ToolkitRSRequirement = Object.freeze({
  contract: SHELL_RS_CONTRACT,
  version: SHELL_RS_VERSION,
  session: 'agent-session',
});

/**
 * What to run: a shell string interpreted by the implementation's shell, or an
 * argv vector executed directly with no shell in between.
 */
export type ShellCommand =
  | Readonly<{ shell: string }>
  | Readonly<{ argv: readonly [string, ...string[]] }>;

export type ShellExecRequest = Readonly<{
  command: ShellCommand;
  cwd: string;
  /** How long to wait for the command to finish before `onTimeout` applies. */
  waitMs: number;
  /**
   * `yield`: keep the command running as a handle in the logical session.
   * `terminate`: end the command and everything it started.
   */
  onTimeout: 'yield' | 'terminate';
  /** Cap on captured characters per stream. */
  maxOutputChars: number;
  /** Variables layered over the RS's own environment. */
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}>;

export type ShellProcessStatus = 'running' | 'exited' | 'terminated';

export type ShellProcessSnapshot = Readonly<{
  processId: string;
  /** Display form of the command that started this process. */
  command: string;
  cwd: string;
  pid: number;
  startedAt: number;
  status: ShellProcessStatus;
  exitCode: number | null;
  exitedAt: number | null;
}>;

export type ShellExecResult =
  | Readonly<{ status: 'exited'; code: number | null; stdout: string; stderr: string }>
  /** Waited past `waitMs` with `onTimeout: 'terminate'`; the command was ended. */
  | Readonly<{ status: 'timeout'; stdout: string; stderr: string }>
  | Readonly<{ status: 'aborted'; stdout: string; stderr: string }>
  | Readonly<{ status: 'spawn_failed'; error: Error }>
  /**
   * Waited past `waitMs` with `onTimeout: 'yield'`; the command keeps running
   * under a handle in this logical session. `stdout`/`stderr` hold what it
   * printed so far, which later reads do not repeat.
   */
  | Readonly<{ status: 'yielded'; process: ShellProcessSnapshot; stdout: string; stderr: string }>;

export type ShellProcessOutput = Readonly<{
  process: ShellProcessSnapshot;
  /** Output produced since the previous read of this process. */
  stdout: string;
  stderr: string;
}>;

export type ShellRSErrorCode =
  | 'unknown_process'
  | 'other_session'
  | 'too_many_processes'
  | 'unavailable';

export class ShellRSError extends Error {
  constructor(
    readonly code: ShellRSErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShellRSError';
  }
}

/**
 * Typed interface a shell-dependent Toolkit receives. Every operation names
 * the Agent session it acts for; process handles are only reachable from the
 * logical session that holds them.
 */
export type ShellRS = ToolkitRS & {
  exec(agentSessionId: string, request: ShellExecRequest): Promise<ShellExecResult>;
  /** Wait for exit, or return current progress once `timeoutMs` elapses. */
  wait(
    agentSessionId: string,
    processId: string,
    timeoutMs: number,
  ): Promise<ShellProcessOutput>;
  /** Take the output produced since the previous read without waiting. */
  read(agentSessionId: string, processId: string): Promise<ShellProcessOutput>;
  terminate(agentSessionId: string, processId: string): Promise<ShellProcessSnapshot>;
  list(agentSessionId: string): Promise<readonly ShellProcessSnapshot[]>;
};

export function describeShellCommand(command: ShellCommand): string {
  return 'shell' in command ? command.shell : command.argv.join(' ');
}
