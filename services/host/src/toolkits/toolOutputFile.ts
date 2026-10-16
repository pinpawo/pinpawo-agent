import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * When a tool result is cut to fit the model's context, the full text is
 * kept in a plain file and the cut result names it, so the model can read
 * the omitted part with the tools it already has (view_file_chunk, rg, sed).
 */

export const TOOL_OUTPUT_DIR = resolve(homedir(), '.pinpawo', 'tool-output');
/** Files are only needed while a run still refers to them. */
const TOOL_OUTPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Each directory is pruned once per process, on its first write. */
const prunedDirs = new Set<string>();

function pruneOldFiles(dir: string, now: number) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > TOOL_OUTPUT_MAX_AGE_MS) rmSync(path, { force: true });
    } catch { /* another Host may have removed it */ }
  }
}

/**
 * Write the full output. On failure (disk full, no permission) it reports
 * why, removes any partial file, and the caller still returns its truncated
 * result.
 */
export function saveFullToolOutput(
  output: string,
  dir = TOOL_OUTPUT_DIR,
): { path: string } | { error: string } {
  let path: string | undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!prunedDirs.has(dir)) {
      prunedDirs.add(dir);
      pruneOldFiles(dir, Date.now());
    }
    path = join(dir, `${randomUUID()}.txt`);
    writeFileSync(path, output, { encoding: 'utf-8', mode: 0o600 });
    return { path };
  } catch (error) {
    if (path) rmSync(path, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    return { error: code ?? (error instanceof Error ? error.message : String(error)) };
  }
}

/** The note a truncation marker carries about where the full output went. */
export function fullOutputNote(output: string, dir?: string) {
  const saved = saveFullToolOutput(output, dir);
  return 'path' in saved
    ? `; full output: ${saved.path}`
    : `; full output not saved (${saved.error}), omitted part is lost`;
}
