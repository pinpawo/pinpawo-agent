import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArtifactUri } from '@pinpawo/agent-contracts';
import type { ArtifactStore } from '@pinpawo-toolkit/artifacts';

export type ArtifactReader = Pick<ArtifactStore, 'fetch'>;

/** Caller authenticates before allowing access to a shared artifact reference. */
export async function serveArtifactHttp(
  request: IncomingMessage,
  response: ServerResponse,
  store: ArtifactReader | undefined,
) {
  const json = (status: number, error: string) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error }));
  };
  if (request.method !== 'GET') { json(405, 'Method not allowed'); return; }
  if (!store) { json(503, 'Artifact storage is unavailable'); return; }
  const uri = new URL(request.url ?? '/', 'http://localhost').searchParams.get('uri');
  try {
    if (!uri) throw new Error('Missing artifact URI');
    parseArtifactUri(uri);
  } catch {
    json(400, 'Invalid artifact URI'); return;
  }
  let fetched: Awaited<ReturnType<ArtifactReader['fetch']>>;
  try {
    fetched = await store.fetch(uri);
  } catch (error) {
    const code = (error as { code?: string; statusCode?: number }).code;
    const missing = code === 'ENOENT' || code === 'NoSuchKey' || (error as { statusCode?: number }).statusCode === 404;
    json(missing ? 404 : 500, missing ? 'Artifact not found' : 'Artifact could not be read'); return;
  }
  if ('url' in fetched) {
    response.writeHead(302, { Location: fetched.url, 'Cache-Control': 'no-store' });
    response.end(); return;
  }
  response.writeHead(200, {
    'Content-Type': fetched.ref.mimeType,
    'Content-Length': fetched.ref.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fetched.ref.name)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  await pipeline(Readable.fromWeb(fetched.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>), response);
}
