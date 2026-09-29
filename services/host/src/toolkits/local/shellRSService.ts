import type { RSServiceHandler } from '../../rsService/server';
import { RSServiceError } from '../../rsService/transport';
import { PosixShellRS } from './posixShellRS';
import {
  SHELL_RS_CONTRACT,
  SHELL_RS_VERSION,
  type ShellCommand,
  type ShellExecRequest,
  type ShellExecResult,
} from './shellRS';

/**
 * ShellRS served by the RS service.
 *
 * The wire shape of each operation is its `ShellRS` signature with the
 * `AbortSignal` replaced by the transport's cancellation, plus `baseEnv` on
 * `exec`: the calling Host's environment, which the command runs in with the
 * request's own `env` layered on top. The service never runs a command in its
 * own environment or its own working directory.
 */

export const SHELL_RS_MANAGEMENT = Object.freeze({
  processes: 'processes',
  terminate: 'terminate',
});

function invalid(message: string): never {
  throw new RSServiceError('invalid_request', message);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) invalid(`Invalid ${field}.`);
  return value;
}

function readNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(`Invalid ${field}.`);
  return value;
}

function readEnv(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid ${field}.`);
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') invalid(`Invalid ${field}.${key}.`);
    env[key] = entry;
  }
  return env;
}

function readCommand(value: unknown): ShellCommand {
  const command = value as Record<string, unknown> | null;
  if (command && typeof command.shell === 'string') return { shell: command.shell };
  if (
    command
    && Array.isArray(command.argv)
    && command.argv.length > 0
    && command.argv.every((part) => typeof part === 'string')
  ) {
    return { argv: command.argv as [string, ...string[]] };
  }
  invalid('Invalid command.');
}

function readArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('Invalid arguments.');
  return args as Record<string, unknown>;
}

function readExecRequest(value: unknown, signal: AbortSignal): ShellExecRequest {
  const request = readArgs(value);
  const onTimeout = request.onTimeout;
  if (onTimeout !== 'yield' && onTimeout !== 'terminate') invalid('Invalid onTimeout.');
  const baseEnv = readEnv(request.baseEnv, 'baseEnv');
  const env = readEnv(request.env, 'env');
  return {
    command: readCommand(request.command),
    cwd: readString(request.cwd, 'cwd'),
    waitMs: readNumber(request.waitMs, 'waitMs'),
    onTimeout,
    maxOutputChars: readNumber(request.maxOutputChars, 'maxOutputChars'),
    ...(baseEnv || env ? { env: { ...baseEnv, ...env } } : {}),
    signal,
  };
}

function encodeExecResult(result: ShellExecResult): unknown {
  if (result.status !== 'spawn_failed') return result;
  const code = (result.error as NodeJS.ErrnoException).code;
  return {
    status: 'spawn_failed',
    error: { message: result.error.message, ...(code ? { code } : {}) },
  };
}

export function createShellRSServiceHandler(
  rs: PosixShellRS = new PosixShellRS(),
): RSServiceHandler {
  return {
    contract: SHELL_RS_CONTRACT,
    version: SHELL_RS_VERSION,
    async call(method, args, { signal }) {
      if (method === 'status') return rs.status();
      const input = readArgs(args);
      const sessionId = readString(input.agentSessionId, 'agentSessionId');
      switch (method) {
        case 'ensureSession':
          rs.ensureSession(sessionId);
          return null;
        case 'exec':
          return encodeExecResult(await rs.exec(sessionId, readExecRequest(input.request, signal)));
        case 'wait':
          return await rs.wait(
            sessionId,
            readString(input.processId, 'processId'),
            readNumber(input.timeoutMs, 'timeoutMs'),
          );
        case 'read':
          return await rs.read(sessionId, readString(input.processId, 'processId'));
        case 'terminate':
          return await rs.terminate(sessionId, readString(input.processId, 'processId'));
        case 'list':
          return await rs.list(sessionId);
        default:
          return invalid(`Unknown ShellRS operation: ${method}`);
      }
    },
    async manage(action, args) {
      if (action === SHELL_RS_MANAGEMENT.processes) {
        const sessionId = args && typeof args === 'object'
          ? (args as Record<string, unknown>).agentSessionId
          : undefined;
        const all = rs.listAllProcesses();
        return typeof sessionId === 'string'
          ? all.filter((process) => process.agentSessionId === sessionId)
          : all;
      }
      if (action === SHELL_RS_MANAGEMENT.terminate) {
        return await rs.terminateProcess(readString(readArgs(args).processId, 'processId'));
      }
      return invalid(`Unknown ShellRS management action: ${action}`);
    },
    describe() {
      const processes = rs.listAllProcesses();
      return {
        sessions: rs.sessionCount,
        processes: processes.length,
        running: processes.filter((process) => process.status === 'running').length,
      };
    },
    busy() {
      return rs.listAllProcesses().some((process) => process.status === 'running');
    },
    async dispose() {
      return await rs.dispose();
    },
  };
}
