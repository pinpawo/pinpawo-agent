import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { parseArtifactUri, type ArtifactRef } from '@pinpawo/agent-contracts';
import { MAX_ARTIFACT_BYTES, type ArtifactStore } from '@pinpawo-toolkit/artifacts';

export function safeArtifactSegment(value: string): string {
  if (!value || value === '.' || value === '..' || /[/\\\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid artifact path segment.');
  }
  return value;
}

/** References contain the workspace and session, so a shared reference can be opened across both. */
export function artifactKeyParts(uri: string): [string, string, string, string] {
  const parts = parseArtifactUri(uri).split('/');
  if (parts.length !== 4) throw new Error('Invalid artifact reference.');
  return parts.map(part => safeArtifactSegment(decodeURIComponent(part))) as [string, string, string, string];
}

export async function writeArtifactBody(path: string, body: ReadableStream<Uint8Array>) {
  const file = await open(path, 'wx', 0o600);
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > MAX_ARTIFACT_BYTES) throw new Error('Artifact exceeds the 100 MB limit.');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    await file.close();
  }
}

export function createLocalArtifactStore(options: { workspacesDir: string; workspaceId: string }): ArtifactStore {
  const workspaceId = safeArtifactSegment(options.workspaceId);
  const checkedPath = async (path: string) => {
    const [root, target] = await Promise.all([realpath(options.workspacesDir), realpath(path)]);
    const subpath = relative(root, target);
    if (subpath === '..' || subpath.startsWith(`..${sep}`) || isAbsolute(subpath)) {
      throw new Error('Artifact path escapes its storage root.');
    }
    return target;
  };
  const objectPath = (uri: string) => {
    const [workspace, thread, id, name] = artifactKeyParts(uri);
    return join(options.workspacesDir, workspace, 'artifacts', thread, id, name);
  };
  const readRef = async (uri: string): Promise<ArtifactRef> => {
    const ref = JSON.parse(await readFile(await checkedPath(`${dirname(objectPath(uri))}.json`), 'utf8')) as ArtifactRef;
    if (ref.uri !== uri) throw new Error('Artifact metadata does not match its reference.');
    return ref;
  };
  return {
    async put(input) {
      const threadId = safeArtifactSegment(input.threadId);
      const name = safeArtifactSegment(input.name);
      const id = randomUUID();
      const uri = `artifact://${[workspaceId, threadId, id, name].map(encodeURIComponent).join('/')}`;
      const target = objectPath(uri);
      const pending = join(dirname(dirname(target)), `.pending-${id}`);
      await mkdir(pending, { recursive: true, mode: 0o700 });
      try {
        const digest = await writeArtifactBody(join(pending, name), input.body);
        const ref: ArtifactRef = { uri, name, ...(input.title ? { title: input.title } : {}),
          mimeType: input.mimeType, ...digest, createdAt: new Date().toISOString() };
        await rename(pending, dirname(target));
        await writeFile(`${dirname(target)}.json.tmp`, JSON.stringify(ref), { flag: 'wx', mode: 0o600 });
        await rename(`${dirname(target)}.json.tmp`, `${dirname(target)}.json`);
        return ref;
      } catch (error) {
        await rm(pending, { recursive: true, force: true });
        await rm(dirname(target), { recursive: true, force: true });
        await rm(`${dirname(target)}.json.tmp`, { force: true });
        throw error;
      }
    },
    async list(threadId) {
      const sessionDir = join(options.workspacesDir, workspaceId, 'artifacts', safeArtifactSegment(threadId));
      const entries = await readdir(sessionDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const refs = await Promise.all(entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(async entry => JSON.parse(await readFile(join(sessionDir, entry.name), 'utf8')) as ArtifactRef));
      return refs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async fetch(uri) {
      const ref = await readRef(uri);
      const path = await checkedPath(objectPath(uri));
      return { ref, body: Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array> };
    },
  };
}
