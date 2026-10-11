import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Replace a file whole: a crash leaves the old or the new content, never a torn write.
 * An existing file keeps its permission bits (e.g. 755 scripts, 600 secrets) across the rename.
 */
export function atomicWriteFile(path: string, data: string | Uint8Array) {
  mkdirSync(dirname(path), { recursive: true });
  const existingMode = existingFileMode(path);
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, data, existingMode === undefined ? undefined : { mode: existingMode });
    // writeFileSync's mode is masked by umask, so set it explicitly.
    if (existingMode !== undefined) chmodSync(tmp, existingMode);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function existingFileMode(path: string) {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.mode & 0o7777 : undefined;
  } catch {
    return undefined;
  }
}
