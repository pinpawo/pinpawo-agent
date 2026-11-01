import { createHash, randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { link, lstat, mkdir, open, realpath, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_DOCUMENTS = 1_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

export type ProjectDocumentSummary = {
  path: string;
  title: string;
  size: number;
  modifiedAt: string;
};

export type ProjectDocument = ProjectDocumentSummary & {
  content: string;
};

export type ProjectFilesServiceOptions = {
  maxDocuments?: number;
  maxFileBytes?: number;
  /** Optional canonical boundary used by installed adapters. */
  boundaryDir?: string;
};

export function projectDocumentDigest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export class ProjectFileTooLargeError extends Error {
  constructor(readonly documentPath: string, readonly maxFileBytes: number) {
    super(`Project Markdown "${documentPath}" exceeds ${maxFileBytes.toString()} bytes.`);
    this.name = 'ProjectFileTooLargeError';
  }
}

function readPositiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function toDocumentPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

export function readDocumentPath(value: string): string {
  const candidate = value;
  if (
    !candidate
    || candidate !== candidate.trim()
    || candidate.includes('\\')
    || candidate.includes('\0')
    || path.posix.isAbsolute(candidate)
    || path.posix.normalize(candidate) !== candidate
    || candidate.split('/').some((segment) => segment === '.' || segment === '..' || !segment)
    || path.posix.extname(candidate).toLowerCase() !== '.md'
  ) {
    throw new Error('Project document path must be a normalized relative Markdown path.');
  }
  return candidate;
}

function ensureInsideRoot(root: string, file: string): void {
  const relative = path.relative(root, file);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Project document resolves outside the configured root.');
  }
}

function ensureAtOrInsideBoundary(boundary: string, candidate: string): void {
  if (candidate === boundary) return;
  ensureInsideRoot(boundary, candidate);
}

/** Fix the real root once; a later symlink swap must not change what this service can read. */
function canonicalRoot(root: string): string {
  let current = path.resolve(root);
  const missing: string[] = [];
  for (;;) {
    try {
      // Match fs/promises.realpath: the JS realpathSync implementation preserves
      // Windows 8.3 aliases (e.g. RUNNER~1), while the native API expands them.
      return path.join(realpathSync.native(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Project document is locked; inspect the PID and creation time in ${lockPath}. After confirming the holding process is no longer running, remove that lock manually before retrying.`);
    }
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n');
    await lock.sync();
  } catch (error) {
    await lock.close();
    await unlink(lockPath);
    throw error;
  }
  return async () => {
    await lock.close();
    await unlink(lockPath);
  };
}

function titleFor(documentPath: string): string {
  return path.posix.basename(documentPath, path.posix.extname(documentPath));
}

export class ProjectFilesService {
  readonly rootDir: string;
  readonly canonicalRoot: string;
  private readonly maxDocuments: number;
  private readonly maxFileBytes: number;
  private readonly boundaryDir: string | undefined;

  constructor(rootDir: string, options: ProjectFilesServiceOptions = {}) {
    this.rootDir = path.resolve(rootDir);
    this.canonicalRoot = canonicalRoot(this.rootDir);
    this.boundaryDir = options.boundaryDir ? path.resolve(options.boundaryDir) : undefined;
    this.maxDocuments = readPositiveInteger(
      options.maxDocuments,
      DEFAULT_MAX_DOCUMENTS,
      'Project Files maxDocuments',
    );
    this.maxFileBytes = readPositiveInteger(
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      'Project Files maxFileBytes',
    );
  }

  private async resolveRoot(): Promise<string | null> {
    try {
      const root = await realpath(this.rootDir);
      if (root !== this.canonicalRoot) throw new Error('Project Files root changed after authorization; restart Studio.');
      if (this.boundaryDir) {
        ensureAtOrInsideBoundary(await realpath(this.boundaryDir), root);
      }
      return root;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async listDocuments(): Promise<ProjectDocumentSummary[]> {
    const root = await this.resolveRoot();
    if (!root) return [];
    const documents: ProjectDocumentSummary[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(file);
          continue;
        }
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
        if (documents.length >= this.maxDocuments) {
          throw new Error(`Project Files contains more than ${this.maxDocuments.toString()} Markdown documents.`);
        }
        const info = await stat(file);
        const documentPath = toDocumentPath(root, file);
        documents.push({
          path: documentPath,
          title: titleFor(documentPath),
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
      }
    };
    await visit(root);
    return documents;
  }

  /**
   * Updates must carry the digest obtained from a prior read, or null for a
   * new file. Cooperative writers share a per-target exclusive lock. An atomic
   * replace avoids partial files, but unrelated editors that ignore the lock
   * can still race between the final comparison and rename. Node's path-based
   * filesystem calls cannot exclude a malicious local directory-symlink swap
   * between validation and mutation; the root must remain locally trusted.
   */
  async writeDocument(value: string, content: string, expectedDigest: string | null, expectedRoot?: string): Promise<{ path: string; digest: string }> {
    const documentPath = readDocumentPath(value);
    if (Buffer.byteLength(content, 'utf8') > this.maxFileBytes) {
      throw new ProjectFileTooLargeError(documentPath, this.maxFileBytes);
    }
    if (expectedDigest !== null && !/^[a-f0-9]{64}$/.test(expectedDigest)) {
      throw new Error('Expected digest must be a SHA-256 hex digest or null.');
    }
    const root = await this.resolveRoot();
    if (!root) throw new Error('Project Files root does not exist.');
    if (expectedRoot && root !== expectedRoot) throw new Error('Project Files root changed after authorization; restart Studio.');
    const parts = documentPath.split('/');
    const name = parts.pop()!;
    let parent = root;
    for (const part of parts) {
      const next = path.join(parent, part);
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if ((await lstat(next)).isSymbolicLink()) throw new Error('Project document writes do not follow symbolic links.');
      parent = await realpath(next);
      ensureInsideRoot(root, parent);
      if (!(await stat(parent)).isDirectory()) throw new Error('Project document parent is not a directory.');
    }
    const target = path.join(parent, name);
    ensureInsideRoot(root, target);
    const lockDirectory = path.join(root, '.project-files-locks');
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if ((await lstat(lockDirectory)).isSymbolicLink()) throw new Error('Project Files lock location cannot be a symbolic link.');
    const canonicalLocks = await realpath(lockDirectory);
    ensureInsideRoot(root, canonicalLocks);
    if (!(await stat(canonicalLocks)).isDirectory()) throw new Error('Project Files lock location is not a directory.');
    const lockPath = path.join(canonicalLocks, `${projectDocumentDigest(target)}.lock`);
    const releaseLock = await acquireLock(lockPath);
    let releaseCreate: (() => Promise<void>) | undefined;
    let temporary: string | undefined;
    try {
      const readExisting = async (): Promise<{ digest: string; mode: number } | null> => {
        let info;
        try {
          info = await lstat(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
        if (info.isSymbolicLink()) throw new Error('Project document writes do not follow symbolic links.');
        if (!info.isFile()) throw new Error('Project document target is not a regular file.');
        if (info.size > this.maxFileBytes) throw new ProjectFileTooLargeError(documentPath, this.maxFileBytes);
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const content = await handle.readFile();
          if (content.byteLength > this.maxFileBytes) throw new ProjectFileTooLargeError(documentPath, this.maxFileBytes);
          return { digest: projectDocumentDigest(content), mode: info.mode & 0o777 };
        } finally {
          await handle.close();
        }
      };
      const existing = await readExisting();
      if ((existing?.digest ?? null) !== expectedDigest) {
        throw new Error('Project document changed since it was read; read it again before writing.');
      }
      if (expectedDigest === null) {
        // Creating different pages must share one lock or both could see the
        // last available slot. This protects writers using this Toolkit.
        releaseCreate = await acquireLock(path.join(canonicalLocks, 'create.lock'));
        if ((await this.listDocuments()).length >= this.maxDocuments) {
          throw new Error(`Project Files cannot create more than ${this.maxDocuments.toString()} Markdown documents.`);
        }
      }
      temporary = path.join(parent, `.project-files-tmp-${randomUUID()}`);
      const output = await open(temporary, 'wx', existing?.mode ?? 0o600);
      try {
        await output.writeFile(content, 'utf8');
        await output.sync();
      } finally {
        await output.close();
      }
      const beforeReplace = await readExisting();
      if ((beforeReplace?.digest ?? null) !== expectedDigest) {
        throw new Error('Project document changed while writing; read it again before retrying.');
      }
      if (expectedDigest === null) {
        // Hard-link creation is atomic and cannot replace a concurrently added file.
        await link(temporary, target);
        await unlink(temporary);
      } else {
        await rename(temporary, target);
      }
      temporary = undefined;
      return { path: documentPath, digest: projectDocumentDigest(content) };
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
      try {
        if (releaseCreate) await releaseCreate();
      } finally {
        await releaseLock();
      }
    }
  }

  async readDocument(value: string): Promise<ProjectDocument | null> {
    const documentPath = readDocumentPath(value);
    const root = await this.resolveRoot();
    if (!root) return null;
    let file: string;
    try {
      file = await realpath(path.join(root, ...documentPath.split('/')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    ensureInsideRoot(root, file);
    const info = await stat(file);
    if (!info.isFile() || path.extname(file).toLowerCase() !== '.md') return null;
    if (info.size > this.maxFileBytes) {
      throw new ProjectFileTooLargeError(documentPath, this.maxFileBytes);
    }
    return {
      path: documentPath,
      title: titleFor(documentPath),
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      content: await readFile(file, 'utf8'),
    };
  }
}
