import { isAbsolute, resolve } from 'node:path';
import {
  readToolExecutionContext,
  type NamedStructuredTool,
} from '@pinpawo/pet-agent';
import { parsePatch } from './applyPatch';

/**
 * The Agent session a shell-dependent tool acts for.
 *
 * ShellRS binds its logical sessions to the Agent session, so a call made
 * outside one has nothing to bind to. Reported as an ordinary tool error.
 */
export function requireAgentSession(config: unknown): string {
  const { agentSessionId } = readToolExecutionContext(config);
  if (!agentSessionId) {
    throw new Error('This tool requires an Agent session (threadId).');
  }
  return agentSessionId;
}

const SINGLE_PATH_TOOLS = new Set([
  'read_file',
  'view_file_chunk',
  'stat_path',
  'write_file',
  'validate_structured_file',
  'mkdir_path',
  'list_dir',
]);

function resolveFromWorkdir(path: unknown, workdir: string) {
  if (typeof path !== 'string' || !path.trim()) return path;
  return isAbsolute(path) ? path : resolve(workdir, path);
}

function bindPatchToWorkdir(patch: unknown, workdir: string) {
  if (typeof patch !== 'string') return patch;
  let update: ReturnType<typeof parsePatch>;
  try {
    update = parsePatch(patch);
  } catch {
    // Preserve the tool's normal structured parse error for invalid input.
    return patch;
  }
  if (isAbsolute(update.path)) return patch;
  const target = resolve(workdir, update.path);
  return patch.replace(
    /^(\*\*\* Update File: ).+$/m,
    (_line, prefix: string) => `${prefix}${target}`,
  );
}

function bindInput(toolName: string, input: unknown, workdir: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;

  if (SINGLE_PATH_TOOLS.has(toolName)) {
    return { ...record, path: resolveFromWorkdir(record.path, workdir) };
  }
  if (toolName === 'move_path' || toolName === 'copy_path') {
    return {
      ...record,
      source: resolveFromWorkdir(record.source, workdir),
      destination: resolveFromWorkdir(record.destination, workdir),
    };
  }
  if (toolName === 'apply_patch') {
    return { ...record, patch: bindPatchToWorkdir(record.patch, workdir) };
  }
  if (
    toolName === 'run_shell'
    || toolName === 'inspect_shell'
    || toolName.startsWith('git_')
    || toolName.startsWith('gh_')
  ) {
    return { ...record, cwd: resolveFromWorkdir(record.cwd ?? '.', workdir) };
  }
  return input;
}

/**
 * Interpret relative local-tool inputs against the call's workdir.
 *
 * A Host can run beside other Hosts in the same process, so changing the
 * process-wide cwd is not a valid way to establish Agent file scope. The Host
 * supplies the workdir as part of each call's fixed execution context; this
 * wrapper reads it when the tool executes — after review, which sees the
 * original arguments — and resolves relative paths and the default cwd from
 * it. The wrapped Tool keeps its identity, schema and metadata; it is built
 * once per Toolkit, not per execution.
 */
export function withExecutionWorkdir<T extends NamedStructuredTool>(tool: T): T {
  const call = Reflect.get(tool as object, '_call', tool);
  if (typeof call !== 'function') return tool;

  return new Proxy(tool, {
    get(target, property, receiver) {
      if (property === '_call') {
        return (input: unknown, runManager: unknown, config: unknown) => {
          const { workdir } = readToolExecutionContext(config);
          return call.call(
            tool,
            workdir ? bindInput(tool.name, input, workdir) : input,
            runManager,
            config,
          );
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
