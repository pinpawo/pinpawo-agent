import { hasOnlyKeys, isJsonObject } from './json';

/** A reference selected for delivery to the caller. */
export type Deliverable = { uri: string; title?: string };

/** A published file snapshot; download URLs are deliberately not persisted here. */
export type ArtifactRef = Deliverable & {
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
};

export function isDeliverable(value: unknown): value is Deliverable {
  return isJsonObject(value)
    && hasOnlyKeys(value, ['uri', 'title'])
    && typeof value.uri === 'string'
    && /^[a-z][a-z0-9+.-]*:\S+$/i.test(value.uri)
    && (value.title === undefined || typeof value.title === 'string');
}

/** Validate declarations at the authoring boundary without rewriting references. */
export function parseDeliverables(value: unknown): Deliverable[] {
  if (!Array.isArray(value) || !value.every(isDeliverable)) {
    throw new Error('Invalid deliverables: expected an array of { uri, title? } references.');
  }
  return value.map(({ uri, title }) => ({ uri, ...(title !== undefined ? { title } : {}) }));
}

/** Resolve a stable reference without URL host normalization or a lookup index. */
export function parseArtifactUri(uri: string): string {
  if (!uri.startsWith('artifact://')) throw new Error('Invalid artifact URI.');
  const key = uri.slice('artifact://'.length);
  if (!key || /[\\?#\u0000-\u0020\u007f]/.test(key)) throw new Error('Invalid artifact URI key.');
  for (const segment of key.split('/')) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { throw new Error('Invalid artifact URI encoding.'); }
    if (!decoded || decoded === '.' || decoded === '..' || /[/\\\u0000-\u001f\u007f]/.test(decoded)) {
      throw new Error('Invalid artifact URI key segment.');
    }
  }
  return key;
}
