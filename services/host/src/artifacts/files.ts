import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { ArtifactDownloadWriter, ArtifactSourceReader } from '@pinpawo-toolkit/artifacts';
import { safeArtifactSegment, writeArtifactBody } from './localStore';

const MIME_TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
  html: 'text/html', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', svg: 'image/svg+xml', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export const readArtifactSource: ArtifactSourceReader = async ({ path, workdir }) => {
  const target = isAbsolute(path) ? path : resolve(workdir ?? process.cwd(), path);
  if (!(await lstat(target)).isFile()) throw new Error('Only ordinary files can be published.');
  const name = basename(target);
  return { name, mimeType: MIME_TYPES[name.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream',
    body: Readable.toWeb(createReadStream(target)) as unknown as ReadableStream<Uint8Array> };
};

export const writeArtifactDownload: ArtifactDownloadWriter = async (input) => {
  const defaultDir = join(tmpdir(), 'pinpawo-artifacts', safeArtifactSegment(input.threadId));
  let target: string;
  if (input.path !== undefined) {
    target = isAbsolute(input.path) ? input.path : resolve(input.workdir ?? process.cwd(), input.path);
  } else {
    await mkdir(defaultDir, { recursive: true, mode: 0o700 });
    const uniqueDir = await mkdtemp(join(defaultDir, 'download-'));
    target = join(uniqueDir, safeArtifactSegment(input.ref.name));
  }
  const pending = join(dirname(target), `.artifact-download-${randomUUID()}`);
  try {
    input.signal?.throwIfAborted();
    const checked = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      input.signal?.throwIfAborted();
      controller.enqueue(chunk);
    } });
    const body = input.body.pipeThrough(checked);
    const digest = await writeArtifactBody(pending, body);
    if (digest.size !== input.ref.size || digest.sha256 !== input.ref.sha256) {
      throw new Error('Downloaded artifact does not match its published snapshot.');
    }
    input.signal?.throwIfAborted();
    await rename(pending, target);
    return target;
  } catch (error) {
    if (!input.body.locked) await input.body.cancel(error).catch(() => undefined);
    await rm(pending, { force: true });
    throw error;
  }
};
