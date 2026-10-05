import type { ToolRuntime } from '@langchain/core/tools';
import { quote } from 'shell-quote';
import { z } from 'zod';
import { readRecord, readString } from '../operationMetadata';
import { requireAgentSession } from '../executionContext';
import type { ShellExecResult, ShellRS } from '../shellRS/shellRS';
import type { CliVerdict } from './cliLevels';

/** Shared plumbing for tools that run one git/gh invocation as argv through ShellRS. */

export const MAX_CLI_OUTPUT_CHARS = 30_000;
/** git_shell / gh_shell cover fetch, pull, push and run logs, so they get longer. */
export const CLI_SHELL_TIMEOUT_MS = 120_000;

/**
 * Runs one CLI invocation as argv through ShellRS, on behalf of the Agent
 * session of the calling tool. git and gh never go through a shell string.
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

export function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

export type CliCommandResult = {
  stdout?: unknown;
  stderr?: unknown;
  status?: number | null;
  error?: Error;
};

export function truncateCliOutput(output: string) {
  if (output.length <= MAX_CLI_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_CLI_OUTPUT_CHARS)}\n[truncated ${output.length - MAX_CLI_OUTPUT_CHARS} chars]`;
}

export function formatCliResult(result: CliCommandResult) {
  const stdout = typeof result.stdout === 'string' ? result.stdout.trimEnd() : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr.trimEnd() : '';
  const output = [stdout, stderr].filter(Boolean).join('\n');

  if (result.status && result.status !== 0) {
    return `Error (exit ${result.status}):\n${truncateCliOutput(output || 'git command failed')}`;
  }

  if (result.error) {
    return `Error: ${result.error.message}`;
  }

  return truncateCliOutput(output || '(no output)');
}

/** Arguments after the program name, exactly as the model gave them. */
export function readCliArgs(input: unknown): string[] {
  const args = readRecord(input)?.args;
  return Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string') : [];
}

/** Operation summary of a git_shell / gh_shell call: the command and its permission level. */
export function summarizeCliCall(program: 'git' | 'gh', input: unknown, classify: (args: string[]) => CliVerdict) {
  const args = readCliArgs(input);
  return {
    target: readString(readRecord(input), 'cwd'),
    summary: quote([program, ...args]),
    details: { level: classify(args).level },
  };
}

export const cliArgsSchema = (program: 'git' | 'gh', example: string) => z.array(z.string())
  .min(1)
  .refine((args) => args[0] !== program, { message: `args 不包含 ${program} 本身` })
  .describe(`${program} 之后的参数数组，每个参数一项，不经 shell 解析，例如 ${example}`);
