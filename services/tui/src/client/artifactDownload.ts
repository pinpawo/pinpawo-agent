import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArtifactUri } from '@pinpawo/agent-contracts';
import { readWireToken } from './localHostConnection';

const MAX_DOWNLOAD_BYTES = 100_000_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Explicit user download. Host credentials never leave its original request. */
export async function downloadArtifact(uri: string, options: {
  port?: number;
  tokenProvider?: () => string | null;
  tempRoot?: string;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** A temporary object URL already obtained over the authenticated connection. */
  sourceUrl?: string;
} = {}): Promise<string> {
  let key: string;
  try { key = parseArtifactUri(uri).key; }
  catch { throw new TypeError('Invalid artifact URI.'); }
  const request = options.fetch ?? globalThis.fetch;
  let target: URL;
  let headers: Record<string, string> = {};
  if (options.sourceUrl !== undefined) {
    target = downloadUrl(options.sourceUrl);
  } else {
    const port = options.port ?? 3210;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError('Invalid Host port.');
    let token: string | null;
    try { token = (options.tokenProvider ?? readWireToken)(); }
    catch { throw new Error('Host auth token is unavailable.'); }
    if (!token) throw new Error('Host auth token is unavailable.');
    target = new URL(`http://127.0.0.1:${port}/agent-session/artifacts?${new URLSearchParams({ uri })}`);
    headers = { Authorization: `Bearer ${token}` };
  }

  let response: Response;
  for (let redirects = 0; ; redirects += 1) {
    try { response = await request(target, { headers, redirect: 'manual', credentials: 'omit' }); }
    catch { throw new Error('Artifact download request failed.'); }
    if (!REDIRECT_STATUSES.has(response.status)) break;
    await response.body?.cancel().catch(() => undefined);
    if (redirects >= 5) throw new Error('Too many artifact download redirects.');
    const location = response.headers.get('location');
    if (!location) throw new Error('Artifact download redirect has no address.');
    target = downloadUrl(location, target);
    headers = {};
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Artifact download failed (${response.status.toString()}).`);
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))
    || Number(length) > MAX_DOWNLOAD_BYTES)) {
    await response.body.cancel().catch(() => undefined);
    throw new Error('Artifact download exceeds 100 MB or has an invalid length.');
  }

  // The private, randomly named directory is owned by this download alone.
  let directory: string;
  try { directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'pinpawo-artifact-')); }
  catch {
    await response.body.cancel().catch(() => undefined);
    throw new Error('Artifact download could not be saved.');
  }
  const name = `artifact-${decodeURIComponent(key.split('/').at(-1)!)
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').slice(-80).replace(/[. ]+$/, '') || 'download'}`;
  const path = join(directory, name);
  const reader = response.body.getReader();
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, 'wx', 0o600);
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DOWNLOAD_BYTES) throw new Error('Artifact download exceeds 100 MB.');
      await file.writeFile(value);
    }
    if (length !== null && size !== Number(length)) throw new Error('Artifact download length does not match.');
    await file.close();
    file = undefined;
    return path;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await file?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    if (error instanceof Error && /^Artifact download (exceeds|length)/.test(error.message)) throw error;
    throw new Error('Artifact download could not be saved.');
  } finally { reader.releaseLock(); }
}

function downloadUrl(value: string, base?: URL): URL {
  let url: URL;
  try { url = new URL(value, base); }
  catch { throw new TypeError('Invalid artifact download address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('Invalid artifact download address.');
  }
  return url;
}
