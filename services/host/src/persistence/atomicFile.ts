import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readOptionalHostFile(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Local replacement primitive, not a multi-process compare-and-swap. */
export async function atomicWriteHostFile(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(data, 'utf8'); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    try {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { console.warn('[host-persistence] directory sync unavailable:', (error as Error).message); }
  } finally { await rm(temp, { force: true }); }
}
