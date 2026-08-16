import type { StructuredTool } from '@langchain/core/tools';
import { parsePatch } from './applyPatch';
import { resolveUserPath } from './pathUtils';

type WorkdirToolInput = Record<string, unknown>;

const BASH_SINGLE_PATH_TOOLS = new Set([
  'read_file',
  'view_file_chunk',
  'stat_path',
  'write_file',
  'validate_structured_file',
  'mkdir_path',
  'list_dir',
  'jq_query',
]);

function bindToolInput(
  staticTool: StructuredTool,
  transform: (input: unknown) => unknown,
): StructuredTool {
  const staticCall = Reflect.get(staticTool as object, '_call', staticTool);
  if (typeof staticCall !== 'function') {
    throw new Error(`Tool "${staticTool.name}" does not expose an execution implementation.`);
  }
  return new Proxy(staticTool, {
    get(target, property, receiver) {
      if (property === '_call') {
        return (input: unknown, ...args: unknown[]) => Reflect.apply(
          staticCall,
          staticTool,
          [transform(input), ...args],
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function inputRecord(input: unknown): WorkdirToolInput | null {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as WorkdirToolInput
    : null;
}

function withResolvedPathFields(
  input: unknown,
  fields: readonly string[],
  workdir: string,
): unknown {
  const record = inputRecord(input);
  if (!record) return input;
  const next = { ...record };
  for (const field of fields) {
    const value = next[field];
    if (typeof value === 'string' && value.trim()) {
      next[field] = resolveUserPath(value.trim(), workdir);
    }
  }
  return next;
}

function withResolvedPatchPath(input: unknown, workdir: string): unknown {
  const record = inputRecord(input);
  const patch = record?.patch;
  if (typeof patch !== 'string') return input;
  try {
    const update = parsePatch(patch);
    const header = `*** Update File: ${update.path}`;
    const resolvedHeader = `*** Update File: ${resolveUserPath(update.path, workdir)}`;
    return { ...record, patch: patch.replace(header, resolvedHeader) };
  } catch {
    // Preserve malformed input so the tool returns its normal parse error.
    return input;
  }
}

export function bindBashToolWorkdir(
  staticTool: StructuredTool,
  workdir: string,
): StructuredTool {
  if (BASH_SINGLE_PATH_TOOLS.has(staticTool.name)) {
    return bindToolInput(staticTool, (input) => withResolvedPathFields(input, ['path'], workdir));
  }
  if (staticTool.name === 'move_path' || staticTool.name === 'copy_path') {
    return bindToolInput(
      staticTool,
      (input) => withResolvedPathFields(input, ['source', 'destination'], workdir),
    );
  }
  if (staticTool.name === 'glob_search' || staticTool.name === 'grep_search') {
    return bindToolInput(staticTool, (input) => {
      const record = inputRecord(input);
      if (!record) return input;
      return {
        ...record,
        path: resolveUserPath(
          typeof record.path === 'string' && record.path.trim() ? record.path.trim() : '.',
          workdir,
        ),
      };
    });
  }
  if (staticTool.name === 'apply_patch') {
    return bindToolInput(staticTool, (input) => withResolvedPatchPath(input, workdir));
  }
  return staticTool;
}

export function bindGitToolWorkdir(
  staticTool: StructuredTool,
  workdir: string,
): StructuredTool {
  return bindToolInput(staticTool, (input) => {
    const record = inputRecord(input);
    if (!record) return input;
    const cwd = typeof record.cwd === 'string' && record.cwd.trim()
      ? resolveUserPath(record.cwd.trim(), workdir)
      : workdir;
    return {
      ...record,
      cwd,
      ...(staticTool.name === 'gh_read_content'
        && typeof record.path === 'string'
        && record.path.trim()
        ? { path: resolveUserPath(record.path.trim(), cwd) }
        : {}),
    };
  });
}

export function requireExecutionWorkdir(
  toolkitName: string,
  workdir: string | null,
): string {
  if (!workdir) {
    throw new Error(`${toolkitName} Toolkit runtime requires an execution workdir.`);
  }
  return workdir;
}
