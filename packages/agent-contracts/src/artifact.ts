export type ArtifactRef = {
  uri: string;
  name: string;
  title?: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
};

/** Keys locate objects directly; they contain encoded, nonempty path segments. */
export function parseArtifactUri(uri: string): { key: string } {
  if (!uri.startsWith('artifact://')) throw new TypeError('Expected an artifact:// reference.');
  const key = uri.slice('artifact://'.length);
  if (!key || /[\s\\?#\u0000-\u001f\u007f]/.test(key)) throw new TypeError('Invalid artifact key.');
  for (const part of key.split('/')) {
    let decoded: string;
    try { decoded = decodeURIComponent(part); } catch { throw new TypeError('Invalid artifact key encoding.'); }
    if (!decoded || decoded === '.' || decoded === '..' || /[/\\\u0000]/.test(decoded)) {
      throw new TypeError('Invalid artifact key segment.');
    }
  }
  return { key };
}

export function createArtifactUri(key: string): string {
  const uri = `artifact://${key}`;
  parseArtifactUri(uri);
  return uri;
}

export function assertArtifactRef(value: unknown): asserts value is ArtifactRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid artifact reference.');
  const ref = value as Partial<ArtifactRef>;
  if (typeof ref.uri !== 'string' || typeof ref.name !== 'string' || !ref.name
    || typeof ref.mimeType !== 'string' || !ref.mimeType || typeof ref.createdAt !== 'string' || !ref.createdAt
    || !Number.isSafeInteger(ref.size) || (ref.size ?? -1) < 0
    || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(ref.sha256)
    || (ref.title !== undefined && typeof ref.title !== 'string')) throw new TypeError('Invalid artifact reference.');
  parseArtifactUri(ref.uri);
}
