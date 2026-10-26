import type { ToolRuntime } from '@langchain/core/tools';
import { requireAgentSession } from '../executionContext';
import type { ShellExecResult, ShellRS } from '../shellRS/shellRS';
import { fullOutputNote } from '../toolOutputFile';

/** Shared plumbing for tools that run one CLI invocation (gh, office) as argv through ShellRS. */

export const MAX_CLI_OUTPUT_CHARS = 30_000;

/**
 * Runs one CLI invocation as argv through ShellRS, on behalf of the Agent
 * session of the calling tool, never through a shell string.
 */
export type CliRunner = (
  argv: readonly [string, ...string[]],
  options: {
    cwd: string;
    timeoutMs: number;
    maxOutputChars: number;
    env?: Readonly<Record<string, string>>;
  },
) => Promise<ShellExecResult>;

export function createCliRunner(shell: ShellRS, runtime: ToolRuntime): CliRunner {
  return async (argv, options) => await shell.exec(requireAgentSession(runtime), {
    command: { argv },
    cwd: options.cwd,
    waitMs: options.timeoutMs,
    onTimeout: 'terminate',
    maxOutputChars: options.maxOutputChars,
    ...(options.env ? { env: options.env } : {}),
    ...(runtime.signal ? { signal: runtime.signal } : {}),
  });
}

export type CliCommandResult = {
  stdout?: unknown;
  stderr?: unknown;
  status?: number | null;
  error?: Error;
};

export function truncateCliOutput(output: string) {
  if (output.length <= MAX_CLI_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_CLI_OUTPUT_CHARS)}\n[truncated ${output.length - MAX_CLI_OUTPUT_CHARS} chars${fullOutputNote(output)}]`;
}

export function formatCliResult(result: CliCommandResult) {
  const stdout = typeof result.stdout === 'string' ? result.stdout.trimEnd() : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr.trimEnd() : '';
  const output = [stdout, stderr].filter(Boolean).join('\n');

  if (result.status && result.status !== 0) {
    return `Error (exit ${result.status}):\n${truncateCliOutput(output || 'command failed')}`;
  }

  if (result.error) {
    return `Error: ${result.error.message}`;
  }

  return truncateCliOutput(output || '(no output)');
}
