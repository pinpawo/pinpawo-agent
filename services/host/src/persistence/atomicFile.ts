import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Local replacement primitive, not a multi-process compare-and-swap. */
export function atomicWriteHostFile(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, data, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path);
    let directory: number | undefined;
    try { directory = openSync(dirname(path), 'r'); fsyncSync(directory); }
    catch (error) { console.warn('[host-persistence] directory sync unavailable:', (error as Error).message); }
    finally { if (directory !== undefined) closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) rmSync(temp);
  }
}
