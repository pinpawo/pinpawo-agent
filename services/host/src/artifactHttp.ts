import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import type { ArtifactStore } from '@pinpawo-toolkit/artifacts';
import { parseArtifactUri } from '@pinpawo/agent-contracts';

export type ArtifactHttpResult =
  | { kind: 'json'; status: number; body: { error: string } }
  | { kind: 'stream'; body: ReadableStream<Uint8Array>; headers: Record<string, string> }
  | { kind: 'redirect'; status: 302; url: string };

/** Shared by the standalone Agent Session transport and Studio HTTP projection. */
export async function readArtifactHttpResult(
  uri: string | null,
  fetchArtifact: ArtifactStore['fetch'] | undefined,
): Promise<ArtifactHttpResult> {
  try {
    if (!uri) throw new TypeError('Missing artifact URI.');
    parseArtifactUri(uri);
  } catch {
    return { kind: 'json', status: 400, body: { error: 'Invalid artifact URI.' } };
  }
  if (!fetchArtifact) return { kind: 'json', status: 503, body: { error: 'Artifact storage is unavailable.' } };
  try {
    const result = await fetchArtifact(uri);
    if ('url' in result) return { kind: 'redirect', status: 302, url: result.url };
    return {
      kind: 'stream', body: result.body,
      headers: {
        'Content-Type': result.ref.mimeType,
        'Content-Length': String(result.ref.size),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.ref.name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      },
    };
  } catch (error) {
    if (error instanceof TypeError) return { kind: 'json', status: 400, body: { error: 'Invalid artifact URI.' } };
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'json', status: 404, body: { error: 'Artifact not found.' } };
    throw error;
  }
}

export async function writeArtifactHttpResult(response: ServerResponse, result: ArtifactHttpResult): Promise<void> {
  const common = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (result.kind === 'stream') {
    response.writeHead(200, { ...common, ...result.headers });
    await pipeline(Readable.fromWeb(result.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>), response);
  } else if (result.kind === 'redirect') {
    response.writeHead(result.status, { ...common, Location: result.url });
    response.end();
  } else {
    response.writeHead(result.status, { ...common, 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result.body));
  }
}
