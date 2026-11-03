import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, rm, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { assertArtifactRef, createArtifactUri, parseArtifactUri, type ArtifactRef } from '@pinpawo/agent-contracts';
import { MAX_ARTIFACT_BYTES, type ArtifactStore } from '@pinpawo-toolkit/artifacts';
import { atomicWriteFile } from './atomicFile';

function encodePathSegment(value: string) {
  return encodeURIComponent(value || '__empty__').replaceAll('.', '%2E');
}

function resolveContainedPath(rootDir: string, ...segments: string[]) {
  const root = resolve(rootDir);
  const candidate = resolve(root, ...segments);
  const relativePath = relative(root, candidate);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error('artifact path escapes its storage scope');
  }
  return candidate;
}

function validateName(name: string) {
  if (!name || name === '.' || name === '..' || /[/\\\u0000]/.test(name)) {
    throw new TypeError('Artifact name must be a single file name.');
  }
}

function readKey(uri: string) {
  const parts = parseArtifactUri(uri).key.split('/');
  if (parts.length !== 4) throw new TypeError('Expected an artifact key with workspace, session, object and name.');
  return { workspace: parts[0]!, thread: parts[1]!, id: parts[2]!, name: parts[3]! };
}

/**
 * Local session snapshots. rootDir is the shared workspaces parent directory,
 * so a received URI can locate another workspace without a reverse index.
 */
export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly rootDir: string, private readonly workspaceId: string) {
    validateName(workspaceId);
  }

  private async root(create = false) {
    if (create) await mkdir(this.rootDir, { recursive: true });
    return await realpath(this.rootDir);
  }

  private async directory(root: string, segments: string[], create = false) {
    let path = root;
    for (const segment of segments) {
      path = resolveContainedPath(path, segment);
      if (create) {
        try { await mkdir(path, { mode: 0o700 }); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) {
        throw new Error('Artifact directory resolves outside its object path.');
      }
    }
    return path;
  }

  private async regularFile(root: string, path: string) {
    resolveContainedPath(root, relative(root, path));
    if (await realpath(path) !== path || !(await lstat(path)).isFile()) {
      throw new Error('Artifact content must be a regular file within its object path.');
    }
    return path;
  }

  private async readRef(root: string, path: string): Promise<ArtifactRef> {
    await this.regularFile(root, path);
    try {
      const ref: unknown = JSON.parse(await readFile(path, 'utf8'));
      assertArtifactRef(ref);
      return ref;
    } catch (cause) {
      throw new Error('Invalid stored artifact metadata.', { cause });
    }
  }

  async put(input: Parameters<ArtifactStore['put']>[0]): Promise<ArtifactRef> {
    validateName(input.name);
    if (!input.threadId.trim() || !input.mimeType.trim()) throw new TypeError('Artifact session and MIME type are required.');
    const reader = input.body.getReader();
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let createdDirectory: string | undefined;
    try {
      const root = await this.root(true);
      const workspace = encodePathSegment(this.workspaceId);
      const thread = Buffer.from(input.threadId).toString('base64url');
      const id = randomUUID();
      const name = encodePathSegment(input.name);
      const threadDir = await this.directory(root, [workspace, 'artifacts', thread], true);
      const metadataDir = await this.directory(root, [workspace, 'artifacts', thread, '.metadata'], true);
      const objectDir = resolveContainedPath(threadDir, id);
      await mkdir(objectDir, { mode: 0o700 });
      createdDirectory = objectDir;
      const temporaryPath = join(objectDir, '.publishing');
      file = await open(temporaryPath, 'wx', 0o600);
      const hash = createHash('sha256');
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ARTIFACT_BYTES) throw new Error('Artifact exceeds the 100 MB file limit.');
        hash.update(value);
        await file.writeFile(value);
      }
      await file.close();
      file = undefined;
      await rename(temporaryPath, join(objectDir, name));
      const ref: ArtifactRef = {
        uri: createArtifactUri([workspace, thread, id, name].join('/')),
        name: input.name, mimeType: input.mimeType, size, sha256: hash.digest('hex'),
        createdAt: new Date().toISOString(),
        ...(input.title !== undefined ? { title: input.title } : {}),
      };
      assertArtifactRef(ref);
      atomicWriteFile(join(metadataDir, `${id}.json`), JSON.stringify(ref));
      return ref;
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      await file?.close().catch(() => undefined);
      if (createdDirectory) await rm(createdDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async list(threadId: string): Promise<ArtifactRef[]> {
    if (!threadId.trim()) throw new TypeError('An artifact session is required.');
    const workspace = encodePathSegment(this.workspaceId);
    const thread = Buffer.from(threadId).toString('base64url');
    let root: string;
    let directory: string;
    try {
      root = await this.root();
      directory = await this.directory(root, [workspace, 'artifacts', thread, '.metadata']);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const refs: ArtifactRef[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const ref = await this.readRef(root, join(directory, entry.name));
      const key = readKey(ref.uri);
      if (key.workspace !== workspace || key.thread !== thread || `${key.id}.json` !== entry.name) {
        throw new Error('Stored artifact metadata does not match its session.');
      }
      refs.push(ref);
    }
    return refs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.uri.localeCompare(b.uri));
  }

  private async openSnapshot(uri: string) {
    const key = readKey(uri);
    const root = await this.root();
    const threadDir = await this.directory(root, [key.workspace, 'artifacts', key.thread]);
    const ref = await this.readRef(root, join(threadDir, '.metadata', `${key.id}.json`));
    if (ref.uri !== uri) throw Object.assign(new Error('Artifact not found.'), { code: 'ENOENT' });
    if (ref.name !== decodeURIComponent(key.name)) {
      throw new Error('Stored artifact metadata does not match its reference.');
    }
    const path = await this.regularFile(root, resolveContainedPath(threadDir, key.id, key.name));
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== ref.size) throw new Error('Artifact content does not match its stored file metadata.');
      return { ref, path, handle };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /** Resolve an existing local snapshot without creating a download or stream. */
  async resolvePath(uri: string): Promise<string> {
    const { path, handle } = await this.openSnapshot(uri);
    await handle.close();
    return path;
  }

  async fetch(uri: string): Promise<{ ref: ArtifactRef; body: ReadableStream<Uint8Array> }> {
    const { ref, handle } = await this.openSnapshot(uri);
    try {
      return { ref, body: Readable.toWeb(handle.createReadStream({ autoClose: true })) as unknown as ReadableStream<Uint8Array> };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}
