import type { ToolRuntime } from '@langchain/core/tools';
import type { RuntimeCaller, RuntimeExecution } from '../../runtimeService/types';
import type { SearchBackend, GrepBackendResult, GlobBackendResult } from './searchBackend';
import type { ProcessSnapshot } from './processRegistry';

export type ShellProcess = Omit<ProcessSnapshot, 'owner'>;
export type ShellOutput = {
  stdout: string;
  stderr: string;
  stdoutTotalChars?: number;
  stderrTotalChars?: number;
};
export type ShellResult = ShellOutput & (
  | { status: 'exited'; code: number | null }
  | { status: 'yielded'; processId: string }
  | { status: 'aborted' | 'timeout' | 'output_limit' }
  | { status: 'spawn_failed'; error: { message: string; code?: string } }
);
export type ShellCommand = {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
};
export type ShellExec = {
  program: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  env?: Readonly<Record<string, string | null>>;
  envMode?: 'minimal';
  failOnOutputLimit?: boolean;
};
export type ShellExecResult = ShellOutput & { code: number | null };
type CallScope = { execution: RuntimeExecution; signal?: AbortSignal };

export interface ShellRuntimeClient {
  readonly kind: 'shell';
  run(args: ShellCommand, scope: CallScope): Promise<ShellResult>;
  exec(args: ShellExec, scope: CallScope): Promise<ShellExecResult>;
  wait(args: { processId: string; timeoutMs: number }, scope: CallScope): Promise<ShellOutput & { process: ShellProcess }>;
  terminate(processId: string, scope: CallScope): Promise<ShellProcess>;
  list(scope: CallScope): Promise<ShellProcess[]>;
  grep(args: Omit<Parameters<SearchBackend['grep']>[0], 'signal'>, scope: CallScope): Promise<GrepBackendResult>;
  glob(args: Omit<Parameters<SearchBackend['glob']>[0], 'signal'>, scope: CallScope): Promise<GlobBackendResult>;
}

/** A stateless adapter: scope belongs to the current invocation, never the client. */
export function createShellRuntimeClient(caller: RuntimeCaller, toolkitName: string): ShellRuntimeClient {
  const call = <T>(method: string, args: unknown, scope: CallScope) => (
    caller.call(toolkitName, method, args, scope.execution, scope.signal) as Promise<T>
  );
  return Object.freeze({
    kind: 'shell' as const,
    run: (args: ShellCommand, scope: CallScope) => call<ShellResult>('shell.run', args, scope),
    async exec(args: ShellExec, scope: CallScope): Promise<ShellExecResult> {
      const result = await call<ShellResult>('shell.exec', args, scope);
      if (result.status === 'exited' && result.code === 0) {
        const { status: _status, ...output } = result;
        return output;
      }
      const message = result.status === 'spawn_failed' ? result.error.message
        : result.status === 'timeout' ? `${args.program} timed out`
          : result.status === 'output_limit' ? `${args.program} output exceeded its limit`
            : result.status === 'aborted' ? 'The operation was aborted'
              : `${args.program} exited with code ${result.status === 'exited' ? result.code : '?'}`;
      const error = Object.assign(new Error(message), {
        code: result.status === 'spawn_failed' ? result.error.code
          : result.status === 'exited' ? result.code : undefined,
        killed: result.status === 'timeout',
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTotalChars: result.stdoutTotalChars,
        stderrTotalChars: result.stderrTotalChars,
      });
      if (result.status === 'aborted') error.name = 'AbortError';
      throw error;
    },
    wait: (args: { processId: string; timeoutMs: number }, scope: CallScope) => (
      call<ShellOutput & { process: ShellProcess }>('shell.wait', args, scope)
    ),
    terminate: (processId: string, scope: CallScope) => call<ShellProcess>('shell.terminate', { processId }, scope),
    list: (scope: CallScope) => call<ShellProcess[]>('shell.list', {}, scope),
    grep: (args: Omit<Parameters<SearchBackend['grep']>[0], 'signal'>, scope: CallScope) => (
      call<GrepBackendResult>('shell.grep', args, scope)
    ),
    glob: (args: Omit<Parameters<SearchBackend['glob']>[0], 'signal'>, scope: CallScope) => (
      call<GlobBackendResult>('shell.glob', args, scope)
    ),
  });
}

export function shellInvocation(runtime: ToolRuntime): CallScope & { client: ShellRuntimeClient } {
  const context = runtime.context as {
    toolkitName?: string;
    toolkitRuntimes?: Readonly<Record<string, unknown>>;
    executionScope?: RuntimeExecution;
  } | undefined;
  const client = context?.toolkitName ? context.toolkitRuntimes?.[context.toolkitName] : undefined;
  if (!client || (client as ShellRuntimeClient).kind !== 'shell') {
    throw new Error('This Toolkit requires a connected Shell Runtime.');
  }
  if (!context?.executionScope) throw new Error('Shell Runtime requires an execution scope.');
  return { client: client as ShellRuntimeClient, execution: context.executionScope, signal: runtime.signal };
}

export function rethrowAbort(error: unknown): void {
  if (error instanceof Error && error.name === 'AbortError') throw error;
}
