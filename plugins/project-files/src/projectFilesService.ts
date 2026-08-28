import { realpath, readdir, readFile, stat } from 'node:fs/promises';
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

function readDocumentPath(value: string): string {
  const candidate = value.trim();
  if (
    !candidate
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

function titleFor(documentPath: string): string {
  return path.posix.basename(documentPath, path.posix.extname(documentPath));
}

export class ProjectFilesService {
  readonly rootDir: string;
  private readonly maxDocuments: number;
  private readonly maxFileBytes: number;
  private readonly boundaryDir: string | undefined;

  constructor(rootDir: string, options: ProjectFilesServiceOptions = {}) {
    this.rootDir = path.resolve(rootDir);
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
