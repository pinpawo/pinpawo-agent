import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { ArtifactSourceReader } from '@pinpawo-toolkit/artifacts';

const mimeTypes: Readonly<Record<string, string>> = {
  '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.txt': 'text/plain', '.log': 'text/plain', '.csv': 'text/csv',
  '.json': 'application/json', '.jsonl': 'application/x-ndjson',
  '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml',
  '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
};

/** Read local files using the same absolute/relative path rule as Files tools. */
export const readLocalArtifactSource: ArtifactSourceReader = async ({ path, workdir }) => {
  if (!path) throw new Error('Artifact source requires a file path.');
  if (!isAbsolute(path) && !workdir) throw new Error('A relative artifact source requires a workdir.');
  const filePath = isAbsolute(path) ? path : resolve(workdir!, path);
  // Reject directories and special files before opening; O_NONBLOCK also keeps
  // a path replaced by a FIFO between stat and open from blocking the Host.
  if (!(await stat(filePath)).isFile()) throw new Error('Artifact source must be a regular file.');
  const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Artifact source must be a regular file.');
    const source = file.createReadStream({ autoClose: true, highWaterMark: 64 * 1024 });
    return {
      name: basename(filePath),
      mimeType: mimeTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      body: Readable.toWeb(source, {
        strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
      }) as ReadableStream<Uint8Array>,
    };
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
};
