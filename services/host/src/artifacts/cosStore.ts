import COS from 'cos-nodejs-sdk-v5';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactRef } from '@pinpawo/agent-contracts';
import type { ArtifactStore } from '@pinpawo-toolkit/artifacts';
import { artifactKeyParts, safeArtifactSegment, writeArtifactBody } from './localStore';

export type CosArtifactConfig = {
  adapter: 'cos'; bucket: string; region: string; prefix?: string;
  secretId: string; secretKey: string;
};

/** The SDK transport seam permits storage tests without cloud credentials. */
type CosClient = Pick<COS, 'putObject' | 'getObject' | 'getBucket' | 'getObjectUrl'>;

export function createCosArtifactStore(
  options: CosArtifactConfig & { workspaceId: string },
  client: CosClient = new COS({ SecretId: options.secretId, SecretKey: options.secretKey }),
): ArtifactStore {
  const workspaceId = safeArtifactSegment(options.workspaceId);
  const prefix = options.prefix?.replace(/^\/+|\/+$/g, '') ?? '';
  if (prefix) prefix.split('/').forEach(safeArtifactSegment);
  const key = (suffix: string) => prefix ? `${prefix}/${suffix}` : suffix;
  const scope = { Bucket: options.bucket, Region: options.region };
  const metadataKey = (uri: string) => {
    const [workspace, thread, id] = artifactKeyParts(uri);
    return key(`.metadata/${workspace}/${thread}/${id}.json`);
  };
  const readRef = async (uri: string): Promise<ArtifactRef> => {
    const result = await client.getObject({ ...scope, Key: metadataKey(uri) });
    const ref = JSON.parse(result.Body!.toString()) as ArtifactRef;
    if (ref.uri !== uri) throw new Error('Artifact metadata does not match its reference.');
    return ref;
  };
  return {
    async put(input) {
      const id = randomUUID();
      const name = safeArtifactSegment(input.name);
      const threadId = safeArtifactSegment(input.threadId);
      const uri = `artifact://${[workspaceId, threadId, id, name].map(encodeURIComponent).join('/')}`;
      const dir = await mkdtemp(join(tmpdir(), 'pinpawo-artifact-upload-'));
      const path = join(dir, 'body');
      try {
        const digest = await writeArtifactBody(path, input.body);
        const ref: ArtifactRef = { uri, name, ...(input.title ? { title: input.title } : {}),
          mimeType: input.mimeType, ...digest, createdAt: new Date().toISOString() };
        await client.putObject({ ...scope, Key: key(artifactKeyParts(uri).join('/')),
          Body: createReadStream(path), ContentLength: ref.size, ContentType: ref.mimeType });
        await client.putObject({ ...scope, Key: metadataKey(uri), Body: JSON.stringify(ref), ContentType: 'application/json' });
        return ref;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async list(threadId) {
      const refs: ArtifactRef[] = [];
      let marker: string | undefined;
      do {
        const result = await client.getBucket({ ...scope,
          Prefix: key(`.metadata/${workspaceId}/${safeArtifactSegment(threadId)}/`), ...(marker ? { Marker: marker } : {}) });
        for (const entry of result.Contents ?? []) {
          const object = await client.getObject({ ...scope, Key: entry.Key });
          refs.push(JSON.parse(object.Body!.toString()) as ArtifactRef);
        }
        marker = String(result.IsTruncated) === 'true' ? result.NextMarker : undefined;
      } while (marker);
      return refs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async fetch(uri) {
      const ref = await readRef(uri);
      const expires = 15 * 60;
      const url = client.getObjectUrl({ ...scope, Key: key(artifactKeyParts(uri).join('/')), Sign: true, Expires: expires });
      return { ref, url, expiresAt: new Date(Date.now() + expires * 1000).toISOString() };
    },
  };
}
