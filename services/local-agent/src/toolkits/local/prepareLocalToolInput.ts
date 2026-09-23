import { isAbsolute, resolve } from 'node:path';
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

function resolveFromWorkdir(path: unknown, workdir: string | null | undefined) {
  if (typeof path !== 'string') return path;
  if (path.length === 0) throw new Error('A file path must not be empty.');
  if (isAbsolute(path)) return path;
  if (!workdir || !isAbsolute(workdir)) throw new Error('This operation requires an absolute execution workdir.');
  return resolve(workdir, path);
}

function bindPatchToWorkdir(patch: unknown, workdir: string | null | undefined) {
  if (typeof patch !== 'string') return patch;
  let update: ReturnType<typeof parsePatch>;
  try {
    update = parsePatch(patch);
  } catch {
    // Preserve the tool's normal structured parse error for invalid input.
    return patch;
  }
  if (isAbsolute(update.path)) return patch;
  const target = resolveFromWorkdir(update.path, workdir);
  return patch.replace(
    /^(\*\*\* Update File: ).+$/m,
    (_line, prefix: string) => `${prefix}${target}`,
  );
}

/** Resolve paths before review; this function never wraps or reconstructs a Tool. */
export function prepareLocalToolInput(
  toolName: string,
  input: unknown,
  workdir: string | null | undefined,
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool input must be an object.');
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
  if (toolName === 'run_shell' || toolName === 'inspect_shell' || toolName.startsWith('git_') || toolName.startsWith('gh_')) {
    return { ...record, cwd: resolveFromWorkdir(
      typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd : '.', workdir,
    ) };
  }
  return record;
}
