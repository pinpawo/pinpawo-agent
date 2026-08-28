import { isAbsolute, resolve } from 'node:path';
import type { NamedStructuredTool } from '@pinpawo/pet-agent';
import { parsePatch } from './applyPatch';

const SINGLE_PATH_TOOLS = new Set([
  'read_file',
  'view_file_chunk',
  'stat_path',
  'write_file',
  'validate_structured_file',
  'mkdir_path',
  'list_dir',
  'jq_query',
]);

const SEARCH_TOOLS = new Set(['glob_search', 'grep_search']);

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
  if (SEARCH_TOOLS.has(toolName)) {
    return { ...record, path: resolveFromWorkdir(record.path ?? '.', workdir) };
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
  if (toolName === 'run_shell' || toolName.startsWith('git_') || toolName.startsWith('gh_')) {
    return { ...record, cwd: resolveFromWorkdir(record.cwd ?? '.', workdir) };
  }
  return input;
}

/**
 * Bind relative local-tool inputs to one Agent execution's workdir.
 *
 * A Host can run beside other Hosts in the same process, so changing the
 * process-wide cwd is not a valid way to establish Agent file scope. The
 * Toolkit runtime already receives that scope; this adapter applies it only
 * while selecting the concrete inputs for one execution.
 */
export function bindToolToExecutionWorkdir(
  tool: NamedStructuredTool,
  workdir: string | null,
): NamedStructuredTool {
  if (!workdir) return tool;
  const call = Reflect.get(tool as object, '_call', tool);
  if (typeof call !== 'function') return tool;

  return new Proxy(tool, {
    get(target, property, receiver) {
      if (property === '_call') {
        return (input: unknown, ...args: unknown[]) => call.call(
          tool,
          bindInput(tool.name, input, workdir),
          ...args,
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
