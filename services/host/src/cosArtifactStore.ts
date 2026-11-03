import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import COS from 'cos-nodejs-sdk-v5';
import {
  assertArtifactRef,
  createArtifactUri,
  parseArtifactUri,
  type ArtifactRef,
} from '@pinpawo/agent-contracts';
import { MAX_ARTIFACT_BYTES, type ArtifactStore } from '@pinpawo-toolkit/artifacts';

export type CosArtifactStoreOptions = {
  workspaceId: string;
  bucket: string;
  region: string;
  prefix?: string;
  secretId: string;
  secretKey: string;
  securityToken?: string;
};

/** The SDK operations this adapter uses; injection keeps tests off the network. */
export type CosArtifactClient = {
  putObject(params: COS.PutObjectParams): Promise<unknown>;
  getObject(params: COS.GetObjectParams): Promise<{ Body: Buffer }>;
  deleteObject(params: COS.DeleteObjectParams): Promise<unknown>;
  getBucket(params: COS.GetBucketParams): Promise<{
    Contents?: Array<{ Key: string }>;
    IsTruncated?: string | boolean;
    NextMarker?: string;
  }>;
  getObjectUrl(params: COS.GetObjectUrlParams,
    callback: (error: unknown, result?: { Url: string }) => void): unknown;
  cancelTask(taskId: string): void;
};

const DOWNLOAD_URL_SECONDS = 3_600;

function encodeSegment(value: string): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\\u0000]/.test(value)) {
    throw new TypeError('Invalid artifact path segment.');
  }
  return encodeURIComponent(value).replaceAll('.', '%2E');
}

function parseKey(uri: string) {
  const { key } = parseArtifactUri(uri);
  const parts = key.split('/');
  if (parts.length !== 4 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) {
    throw new TypeError('Invalid artifact object key.');
  }
  const [workspace, thread, id] = parts as [string, string, string, string];
  return { key, metadata: `${workspace}/${thread}/.metadata/${id}.json`, workspace, thread, id };
}

function sdkError(error: unknown): Error {
  const details = error as { message?: unknown; code?: unknown; statusCode?: unknown; error?: { Code?: unknown } } | null;
  const code = details?.code ?? details?.error?.Code;
  const notFound = details?.statusCode === 404 || code === 'NoSuchKey' || code === 'NoSuchObject';
  const failure = error instanceof Error ? error : new Error(
    typeof details?.message === 'string' ? details.message : 'COS request failed.',
  );
  if (notFound) Object.assign(failure, { code: 'ENOENT' });
  return failure;
}

/** COS keeps the same stable keys as the local adapter; only fetch creates URLs. */
export class CosArtifactStore implements ArtifactStore {
  private readonly client: CosArtifactClient;
  private readonly prefix: string;
  private readonly workspace: string;

  constructor(private readonly options: CosArtifactStoreOptions, client?: CosArtifactClient) {
    this.workspace = encodeSegment(options.workspaceId);
    if (!options.bucket.trim() || !options.region.trim() || !options.secretId || !options.secretKey) {
      throw new TypeError('COS artifacts require bucket, region, secretId and secretKey.');
    }
    this.prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');
    if ((this.prefix && this.prefix.split('/').some(part => !part || part === '.' || part === '..'))
      || /[\\\u0000]/.test(this.prefix)) {
      throw new TypeError('Invalid COS artifact prefix.');
    }
    this.client = client ?? new COS({
      SecretId: options.secretId,
      SecretKey: options.secretKey,
      ...(options.securityToken ? { SecurityToken: options.securityToken } : {}),
      Protocol: 'https:',
      Timeout: 30_000,
    });
  }

  private object(key: string) {
    return {
      Bucket: this.options.bucket,
      Region: this.options.region,
      Key: this.prefix ? `${this.prefix}/${key}` : key,
    };
  }

  async put(input: Parameters<ArtifactStore['put']>[0]): Promise<ArtifactRef> {
    if (!input.threadId || !input.mimeType || (input.title !== undefined && typeof input.title !== 'string')) {
      throw new TypeError('Invalid artifact publication.');
    }
    const thread = Buffer.from(input.threadId).toString('base64url');
    const id = randomUUID();
    const key = `${this.workspace}/${thread}/${id}/${encodeSegment(input.name)}`;
    const uri = createArtifactUri(key);
    const metadata = `${this.workspace}/${thread}/.metadata/${id}.json`;
    const hash = createHash('sha256');
    let size = 0;
    const source = Readable.fromWeb(input.body as import('node:stream/web').ReadableStream<Uint8Array>);
    const measured = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      if (size > MAX_ARTIFACT_BYTES) {
        callback(new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes (100 MB).`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    } });
    let uploadTask: string | undefined;
    let contentWritten = false;
    let metadataAttempted = false;
    // Start both sides together; pipeline propagates source errors and honors
    // backpressure instead of buffering the file while the SDK consumes it.
    const feeding = pipeline(source, measured);
    try {
      const upload = Promise.resolve().then(() => this.client.putObject({
        ...this.object(key), Body: measured, ContentType: input.mimeType,
        ContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(input.name).replace(/[!'()*]/g,
          char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        onTaskReady: taskId => { uploadTask = taskId; },
      })).then(() => { contentWritten = true; });
      await Promise.all([feeding, upload]);
      const ref: ArtifactRef = {
        uri, name: input.name, mimeType: input.mimeType, size,
        sha256: hash.digest('hex'), createdAt: new Date().toISOString(),
        ...(input.title === undefined ? {} : { title: input.title }),
      };
      metadataAttempted = true;
      await this.client.putObject({
        ...this.object(metadata), Body: Buffer.from(JSON.stringify(ref)), ContentType: 'application/json',
      });
      return ref;
    } catch (error) {
      source.destroy();
      measured.destroy();
      if (uploadTask && !contentWritten) this.client.cancelTask(uploadTask);
      // A failed content stream is not published. If content completed, remove
      // only this attempt's objects; no historical artifact is managed here.
      const cleanup = await Promise.allSettled([
        ...(metadataAttempted ? [this.client.deleteObject(this.object(metadata))] : []),
        ...(contentWritten ? [this.client.deleteObject(this.object(key))] : []),
      ]);
      if (cleanup.some(result => result.status === 'rejected')) {
        throw new Error('COS artifact publication failed and cleanup could not be confirmed.', { cause: sdkError(error) });
      }
      throw sdkError(error);
    }
  }

  private async readReference(metadata: string): Promise<ArtifactRef> {
    let body: Buffer;
    try { body = (await this.client.getObject(this.object(metadata))).Body; } catch (error) { throw sdkError(error); }
    try {
      const ref: unknown = JSON.parse(body.toString('utf8'));
      assertArtifactRef(ref);
      if (parseKey(ref.uri).metadata !== metadata) throw new Error('Artifact metadata does not match its object.');
      return ref;
    } catch (error) {
      throw new Error('Invalid stored artifact metadata.', { cause: error });
    }
  }

  async list(threadId: string): Promise<ArtifactRef[]> {
    if (!threadId) throw new TypeError('An artifact session is required.');
    const metadataPrefix = `${this.workspace}/${Buffer.from(threadId).toString('base64url')}/.metadata/`;
    const objectPrefix = this.object(metadataPrefix).Key;
    const refs: ArtifactRef[] = [];
    let marker: string | undefined;
    do {
      let page: Awaited<ReturnType<CosArtifactClient['getBucket']>>;
      try {
        page = await this.client.getBucket({
          Bucket: this.options.bucket, Region: this.options.region, Prefix: objectPrefix,
          MaxKeys: 1_000, ...(marker ? { Marker: marker } : {}),
        });
      } catch (error) { throw sdkError(error); }
      for (const object of page.Contents ?? []) {
        const suffix = object.Key.slice(objectPrefix.length);
        if (!object.Key.startsWith(objectPrefix) || !suffix.endsWith('.json') || suffix.includes('/')) {
          throw new Error('Unexpected COS artifact metadata object.');
        }
        refs.push(await this.readReference(`${metadataPrefix}${suffix}`));
      }
      if (page.IsTruncated === true || page.IsTruncated === 'true') {
        if (!page.NextMarker || page.NextMarker === marker) throw new Error('COS artifact listing did not advance.');
        marker = page.NextMarker;
      } else marker = undefined;
    } while (marker);
    return refs.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.uri.localeCompare(right.uri));
  }

  async fetch(uri: string): Promise<{ ref: ArtifactRef; url: string; expiresAt: string }> {
    const parsed = parseKey(uri);
    const ref = await this.readReference(parsed.metadata);
    if (ref.uri !== uri) throw Object.assign(new Error('Artifact not found.'), { code: 'ENOENT' });
    const expiresAt = new Date(Date.now() + DOWNLOAD_URL_SECONDS * 1_000).toISOString();
    const url = await new Promise<string>((resolve, reject) => {
      this.client.getObjectUrl({
        ...this.object(parsed.key), Sign: true, Method: 'GET', Protocol: 'https:', Expires: DOWNLOAD_URL_SECONDS,
      }, (error, result) => {
        if (error) reject(sdkError(error));
        else if (!result?.Url) reject(new Error('COS did not return a download URL.'));
        else resolve(result.Url);
      });
    });
    return { ref, url, expiresAt };
  }
}
