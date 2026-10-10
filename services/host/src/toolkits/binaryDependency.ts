import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export type BinaryDependency = Readonly<{
  toolkit: string;
  version: string;
  filename: string;
  url: string;
  sha256: string;
}>;

export const TOOLKIT_DEPENDENCY_ROOT = resolve(homedir(), '.pinpawo', 'toolkits');
const MAX_BINARY_BYTES = 256 * 1024 * 1024;

export function dependencyPath(dependency: BinaryDependency, root = TOOLKIT_DEPENDENCY_ROOT) {
  return resolve(root, dependency.toolkit, dependency.version, dependency.filename);
}

export async function binaryDependencyStatus(dependency: BinaryDependency, root?: string) {
  const path = dependencyPath(dependency, root);
  let state: 'installed' | 'missing' | 'invalid' = 'missing';
  try {
    const file = await stat(path);
    state = 'invalid';
    if (file.isFile() && file.size <= MAX_BINARY_BYTES) {
      const hash = createHash('sha256').update(await readFile(path)).digest('hex');
      if (hash === dependency.sha256) {
        await access(path, constants.X_OK);
        state = 'installed';
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Permission errors are invalid, never a successful install.
      state = 'invalid';
    }
  }
  return { toolkit: dependency.toolkit, version: dependency.version, path, state, source: dependency.url };
}

/** Explicit CLI operation only. Downloads verified bytes; never executes them. */
export async function installBinaryDependency(
  dependency: BinaryDependency,
  options: { root?: string; fetch?: typeof fetch } = {},
) {
  const before = await binaryDependencyStatus(dependency, options.root);
  if (before.state === 'installed') return { ...before, alreadyInstalled: true };
  const response = await (options.fetch ?? fetch)(dependency.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Dependency download failed: HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_BINARY_BYTES) throw new Error('Dependency download exceeds 256 MiB.');
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks);
  if (createHash('sha256').update(content).digest('hex') !== dependency.sha256) {
    throw new Error('Dependency checksum mismatch; binary was not installed.');
  }
  const temporary = `${before.path}.${randomUUID()}.tmp`;
  await mkdir(dirname(before.path), { recursive: true });
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o700 });
    await chmod(temporary, 0o700);
    await rename(temporary, before.path);
  } finally { await rm(temporary, { force: true }); }
  const after = await binaryDependencyStatus(dependency, options.root);
  if (after.state !== 'installed') throw new Error(`Dependency installation verification failed: ${after.state}`);
  return { ...after, alreadyInstalled: false };
}
