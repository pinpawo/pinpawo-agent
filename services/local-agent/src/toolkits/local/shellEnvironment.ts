import { accessSync, constants, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { rgPath } from '@vscode/ripgrep';
import { z } from 'zod';
import type { RuntimeInstance, RuntimeCallContext, RuntimeInstanceConfig } from '../../runtimeService/types';
import { posixProcessExecutor } from './processTree';
import { createWindowsProcessExecutor } from './windowsProcessExecutor';
import { ProcessRegistry, type ManagedProcessOwner, type ProcessSnapshot } from './processRegistry';
import { createRipgrepSearchBackend } from './searchBackend';
import type { ShellResult } from './shellClient';

const absolutePath = z.string().min(1).refine(isAbsolute, 'Runtime paths must be absolute.');
const invocationOptions = {
  cwd: absolutePath,
  timeoutMs: z.number().int().positive().max(600_000),
  maxOutputChars: z.number().int().positive().max(8 * 1024 * 1024),
};
const commandSchema = z.object({ command: z.string().min(1), ...invocationOptions });
const execSchema = z.object({
  program: z.string().min(1), args: z.array(z.string()), ...invocationOptions,
  env: z.record(z.string(), z.string().nullable()).optional(),
  envMode: z.literal('minimal').optional(), failOnOutputLimit: z.boolean().optional(),
});
const processSchema = z.object({ processId: z.string().min(1) });
const waitSchema = processSchema.extend({ timeoutMs: z.number().int().min(0).max(600_000) });
const grepSchema = z.object({
  rootPath: absolutePath, query: z.string(), literal: z.boolean(), caseSensitive: z.boolean(),
  glob: z.string().optional(), context: z.number().int().min(0).max(10),
  maxMatches: z.number().int().positive().max(201),
});
const globSchema = z.object({
  rootPath: absolutePath, pattern: z.string(), maxResults: z.number().int().positive().max(201),
});
const environmentSchema = z.object({
  kind: z.literal('shell'), shell: z.string().optional(), defaultShell: z.string().optional(),
  env: z.record(z.string(), z.string().nullable()).optional(),
  programs: z.record(z.string(), z.string()).optional(), pathBase: absolutePath.optional(),
});

function normalizedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    result[process.platform === 'win32' && key.toLowerCase() === 'path' ? 'PATH' : key] = value;
  }
  return result;
}

function applyEnv(base: NodeJS.ProcessEnv, overrides: Readonly<Record<string, string | null>> = {}) {
  const result = normalizedEnv(base);
  for (const [key, value] of Object.entries(overrides)) {
    const name = process.platform === 'win32' && key.toLowerCase() === 'path' ? 'PATH' : key;
    if (value === null) delete result[name]; else result[name] = value;
  }
  return result;
}

function executable(path: string) {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return statSync(path).isFile();
  } catch { return false; }
}

function publicProcess(record: ProcessSnapshot) {
  const { owner: _owner, ...result } = record;
  return result;
}

/** One configured execution environment, owned only by the runtime service. */
export function createShellEnvironment(config: RuntimeInstanceConfig): RuntimeInstance {
  const options = environmentSchema.parse(config);
  const snapshot = normalizedEnv(process.env);
  const initial = options.env && Object.keys(options.env).length === 0 ? {} : snapshot;
  const environment = applyEnv(initial, options.env);
  const systemRoot = environment.SystemRoot ?? snapshot.SystemRoot ?? 'C:\\Windows';
  if (process.platform === 'win32' && options.env && Object.keys(options.env).length === 0) {
    // Windows platform baseline only; an empty environment does not inherit
    // application variables, credentials, or the launching Host's PATH.
    environment.SystemRoot = systemRoot;
  }
  const configuredPath = environment.PATH ?? (process.platform === 'win32'
    ? [join(systemRoot, 'System32'), join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(delimiter)
    : '/usr/bin:/bin:/usr/sbin:/sbin');
  const pathEntries = configuredPath.split(delimiter).map((part) => {
    if (isAbsolute(part)) return part;
    if (!options.pathBase) throw new Error('Relative or empty PATH entries require an explicit absolute pathBase.');
    return resolve(options.pathBase, part || '.');
  });
  const programPaths = { ...(options.programs ?? {}) };
  const selected = new Map<string, string>();
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.com'] : [''];
  const discover = (name: string): string | undefined => {
    if (isAbsolute(name)) return executable(name) ? name : undefined;
    return pathEntries.flatMap((entry) => suffixes.map((suffix) => join(entry, name + suffix)))
      .find(executable);
  };
  const choose = (name: string, required = true): string | undefined => {
    const known = selected.get(name);
    if (known) {
      if (!executable(known)) throw new Error(`Configured executable is no longer available: ${known}`);
      return known;
    }
    const configured = programPaths[name];
    if (configured && !isAbsolute(configured)) throw new Error(`programs.${name} must be an absolute path.`);
    const candidate = configured ?? (name === 'rg' ? rgPath : discover(name));
    if (candidate && executable(candidate)) {
      selected.set(name, candidate);
      return candidate;
    }
    if (configured || required) {
      throw Object.assign(new Error(`${name} is not installed or is not available in this Shell environment.`), { code: 'ENOENT' });
    }
    return undefined;
  };
  for (const name of Object.keys(programPaths)) choose(name);
  const configuredShell = options.shell ?? options.defaultShell
    ?? (process.platform === 'win32' ? environment.PINPAWO_WINDOWS_SHELL : undefined);
  const shell = configuredShell
    ? choose(configuredShell)
    : (process.platform === 'win32' ? choose('powershell.exe') : choose('bash', false) ?? choose('zsh'));
  if (!shell) throw new Error('No supported shell is available.');
  const allowedShells = process.platform === 'win32'
    ? ['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'] : ['bash', 'zsh'];
  if (!allowedShells.includes(basename(shell))) throw new Error('Shell must be bash/zsh (PowerShell on Windows).');
  const bin = mkdtempSync(join(tmpdir(), 'pinpawo-shell-'));
  const windowsDirectories = new Set<string>();
  const projectProgram = (name: string, target: string) => {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return;
    if (process.platform === 'win32') {
      // A directory mapping preserves the native executable and adjacent DLLs.
      // Renaming an executable would require a launcher; reject that configuration.
      if (!suffixes.some((suffix) => basename(target).toLowerCase() === (name + suffix).toLowerCase())) {
        throw new Error(`Windows executable mapping must preserve its native filename: ${name}`);
      }
      windowsDirectories.add(dirname(target));
    } else if (!existsSync(join(bin, name))) {
      // Execute the original path so script launchers can resolve helpers from
      // their own $0 directory. A symlink here changes that directory to bin.
      const quotedTarget = `'${target.replaceAll("'", "'\\''")}'`;
      writeFileSync(join(bin, name), `#!/bin/sh\nexec ${quotedTarget} "$@"\n`, { mode: 0o700 });
    }
  };
  try {
    for (const name of ['rg', 'git', 'gh', 'jq', ...Object.keys(programPaths)]) {
      const target = choose(name, name === 'rg');
      if (target) projectProgram(name, target);
    }
  } catch (error) { rmSync(bin, { recursive: true, force: true }); throw error; }
  const executionEnv = () => Object.freeze({
    ...environment,
    PATH: [bin, ...windowsDirectories, ...pathEntries].join(delimiter),
  });
  if (process.platform === 'win32') {
    for (const [name, target] of selected) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) continue;
      const first = [...windowsDirectories, ...pathEntries]
        .flatMap((entry) => suffixes.map((suffix) => join(entry, name + suffix))).find(executable);
      if (first?.toLowerCase() !== target.toLowerCase()) {
        rmSync(bin, { recursive: true, force: true });
        throw new Error(`Conflicting Windows PATH mappings for ${name}.`);
      }
    }
  }
  const executor = process.platform === 'win32'
    ? createWindowsProcessExecutor(executionEnv(), choose('taskkill')!) : posixProcessExecutor;
  const registry = new ProcessRegistry();
  const closedClients = new Set<string>();
  const active = new Map<string, Set<{ abort: AbortController; done: Promise<void> }>>();
  let closed = false;

  const owner = (context: RuntimeCallContext): ManagedProcessOwner => ({
    clientId: context.clientId, toolkitName: context.toolkitName,
    threadId: context.execution.threadId, taskId: context.execution.taskId, runId: context.execution.runId,
    delegationId: context.execution.delegationId,
  });
  const resultFor = (outcome: Awaited<ReturnType<typeof executor.run>>): ShellResult => {
    if (outcome.status === 'yielded') throw new Error('Unregistered process handle.');
    if (outcome.status === 'spawn_failed') return {
      status: 'spawn_failed', stdout: '', stderr: '',
      error: { message: outcome.error.message, code: (outcome.error as NodeJS.ErrnoException).code },
    };
    if (outcome.status === 'exited') {
      const { pid: _pid, ...result } = outcome;
      return result;
    }
    return outcome;
  };
  const releaseClient = async (clientId: string) => {
    closedClients.add(clientId);
    const calls = [...(active.get(clientId) ?? [])];
    for (const call of calls) call.abort.abort();
    await Promise.all(calls.map((call) => call.done));
    await registry.stopClient(clientId);
  };
  return {
    async call(method, input, context) {
      if (closed || closedClients.has(context.clientId)) throw new Error('Shell Runtime client is closed.');
      const abort = new AbortController();
      const cancel = () => abort.abort();
      context.signal.addEventListener('abort', cancel, { once: true });
      if (context.signal.aborted) abort.abort();
      let finish!: () => void;
      const entry = { abort, done: new Promise<void>((resolveDone) => { finish = resolveDone; }) };
      const calls = active.get(context.clientId) ?? new Set();
      active.set(context.clientId, calls);
      calls.add(entry);
      const processOwner = owner(context);
      try {
        if (abort.signal.aborted) throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
        if (method === 'shell.list') return registry.list(processOwner).map(publicProcess);
        if (method === 'shell.wait') {
          const args = waitSchema.parse(input);
          const result = await registry.wait(args.processId, processOwner, args.timeoutMs, abort.signal);
          return { ...result, process: publicProcess(result.process) };
        }
        if (method === 'shell.terminate') {
          return publicProcess(await registry.terminate(processSchema.parse(input).processId, processOwner));
        }
        if (method === 'shell.grep' || method === 'shell.glob') {
          const search = createRipgrepSearchBackend(choose('rg')!, executionEnv());
          return await (method === 'shell.grep'
            ? search.grep({ ...grepSchema.parse(input), signal: abort.signal })
            : search.glob({ ...globSchema.parse(input), signal: abort.signal }));
        }
        if (method !== 'shell.run' && method !== 'shell.exec') throw new Error(`Unknown Shell operation: ${method}`);
        const args = method === 'shell.run' ? commandSchema.parse(input) : execSchema.parse(input);
        if (method === 'shell.run') {
          // Validate pinned targets before invoking their PATH launchers.
          // Previously missing optional programs may be discovered from the same snapshot.
          for (const name of ['rg', 'git', 'gh', 'jq', ...Object.keys(programPaths)]) {
            const target = choose(name, name === 'rg');
            if (target) projectProgram(name, target);
          }
        }
        let env: NodeJS.ProcessEnv = executionEnv();
        let program: string | undefined;
        if ('program' in args) {
          try { program = choose(args.program)!; } catch (error) {
            return resultFor({ status: 'spawn_failed', error: error as Error });
          }
          projectProgram(args.program, program);
          env = executionEnv();
          env = applyEnv(args.envMode === 'minimal' ? {
            PATH: env.PATH, ...(process.platform === 'win32' ? { SystemRoot: env.SystemRoot } : {}),
          } : env, args.env);
        }
        const outcome = await executor.run({
          command: 'command' in args ? args.command : args.program,
          cwd: args.cwd, timeoutMs: args.timeoutMs, maxOutputChars: args.maxOutputChars,
          env, shell, signal: abort.signal, yieldOnTimeout: method === 'shell.run',
          ...('program' in args ? { executable: program, args: args.args, failOnOutputLimit: args.failOnOutputLimit ?? true } : {}),
        });
        if (outcome.status === 'yielded') {
          if (closed || closedClients.has(context.clientId)) {
            outcome.handle.terminate();
            await outcome.handle.wait();
            throw new Error('Shell Runtime client closed while starting a process.');
          }
          try {
            const process = registry.register({
              handle: outcome.handle, owner: processOwner,
              command: 'command' in args ? args.command : args.program,
              cwd: args.cwd, outputAlreadyDelivered: true,
            });
            return { status: 'yielded', processId: process.processId,
              stdout: outcome.handle.stdout, stderr: outcome.handle.stderr } satisfies ShellResult;
          } catch (error) { outcome.handle.terminate(); await outcome.handle.wait(); throw error; }
        }
        return resultFor(outcome);
      } finally {
        context.signal.removeEventListener('abort', cancel);
        calls.delete(entry);
        if (calls.size === 0) active.delete(context.clientId);
        finish();
      }
    },
    releaseClient,
    async close() {
      closed = true;
      await Promise.all([...active.keys()].map(releaseClient));
      await registry.stopAll();
      rmSync(bin, { recursive: true, force: true });
    },
    diagnose: () => ({
      runtimeKind: 'shell', shell, state: closed ? 'closed' : 'ready', processCount: registry.size,
      processTreeCleanup: process.platform === 'win32' ? 'live-parent-only' : 'process-group',
    }),
  };
}
