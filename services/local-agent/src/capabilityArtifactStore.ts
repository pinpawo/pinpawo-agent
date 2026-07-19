import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import type {
  CapabilityArtifactRef,
  CapabilityArtifactStore,
  CapabilityArtifactWriteInput,
} from '@pinpawo/pet-agent';

export function defaultCapabilityArtifactRoot(workdir = process.cwd()) {
  return resolve(workdir, '.pinpawo', 'capability-artifacts');
}

export const DEFAULT_CAPABILITY_ARTIFACT_ROOT = defaultCapabilityArtifactRoot();

type StoredArtifactRef = CapabilityArtifactRef & {
  relativePath?: string;
  turnId?: string;
};

type ArtifactManifest = {
  version: 1;
  threadId: string;
  delegationId: string;
  runId: string;
  turnId?: string;
  capabilityId: string;
  createdAt: string;
  artifacts: StoredArtifactRef[];
};

function encodePathSegment(value: string) {
  return encodeURIComponent(value || '__empty__');
}

export function resolveCapabilityArtifactThreadRoot(rootDir: string, threadId: string) {
  return join(rootDir, 'threads', encodePathSegment(threadId));
}

function atomicWriteFile(path: string, data: string | Uint8Array) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function sha256(data: string | Uint8Array) {
  return createHash('sha256').update(data).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function extensionForMimeType(mimeType: string) {
  if (mimeType === 'application/json') return '.json';
  if (mimeType === 'text/markdown') return '.md';
  if (mimeType.startsWith('text/')) return '.txt';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'video/mp4') return '.mp4';
  if (mimeType === 'application/pdf') return '.pdf';
  return '.artifact';
}

function serializeContent(content: unknown, mimeType: string): string | Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }
  if (typeof content === 'string') return content;
  if (content === undefined) return '';
  return mimeType === 'application/json'
    ? JSON.stringify(content, null, 2)
    : String(content);
}

function isTextReadableMimeType(mimeType: string) {
  return mimeType.startsWith('text/')
    || mimeType === 'application/json'
    || mimeType.endsWith('+json')
    || mimeType === 'application/xml'
    || mimeType.endsWith('+xml');
}

function readManifest(path: string): ArtifactManifest | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as ArtifactManifest;
    if (!Array.isArray(record.artifacts)) return null;
    const runId = record.runId ?? record.turnId ?? '';
    return {
      ...record,
      runId,
      artifacts: record.artifacts.map((artifact) => ({
        ...artifact,
        runId: artifact.runId ?? artifact.turnId ?? runId,
      })),
    };
  } catch {
    return null;
  }
}

function parseArtifactUri(uri: string) {
  const match = /^capability-artifact:\/\/thread\/([^/]+)\/delegation\/([^/]+)\/artifact\/([^/]+)$/.exec(uri);
  if (!match) return null;
  return {
    threadId: decodeURIComponent(match[1] ?? ''),
    delegationId: decodeURIComponent(match[2] ?? ''),
    artifactId: decodeURIComponent(match[3] ?? ''),
  };
}

function readUtf8Prefix(path: string, maxBytes: number) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    const decoder = new StringDecoder('utf8');
    return decoder.write(buffer.subarray(0, bytesRead));
  } finally {
    closeSync(fd);
  }
}

export class FileCapabilityArtifactStore implements CapabilityArtifactStore {
  private readonly manifestLocks = new Map<string, Promise<void>>();

  constructor(private readonly rootDir = DEFAULT_CAPABILITY_ARTIFACT_ROOT) {}

  private threadDir(threadId: string) {
    return resolveCapabilityArtifactThreadRoot(this.rootDir, threadId);
  }

  private delegationDir(threadId: string, delegationId: string) {
    return join(this.threadDir(threadId), encodePathSegment(delegationId));
  }

  private manifestPath(threadId: string, delegationId: string) {
    return join(this.delegationDir(threadId, delegationId), 'manifest.json');
  }

  private readStoredArtifact(params: {
    uri: string;
    threadId?: string;
  }): { parsed: NonNullable<ReturnType<typeof parseArtifactUri>>; stored: StoredArtifactRef } {
    const parsed = parseArtifactUri(params.uri);
    if (!parsed) {
      throw new Error('invalid capability artifact uri');
    }
    if (params.threadId && parsed.threadId !== params.threadId) {
      throw new Error('capability artifact belongs to another thread');
    }
    const manifest = readManifest(this.manifestPath(parsed.threadId, parsed.delegationId));
    const stored = manifest?.artifacts.find((item) => item.id === parsed.artifactId);
    if (!stored) {
      throw new Error('capability artifact not found');
    }
    return { parsed, stored };
  }

  private async withManifestLock<T>(manifestPath: string, run: () => Promise<T>): Promise<T> {
    const previous = this.manifestLocks.get(manifestPath) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    this.manifestLocks.set(manifestPath, previous.then(() => next, () => next));
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.manifestLocks.get(manifestPath) === next) {
        this.manifestLocks.delete(manifestPath);
      }
    }
  }

  private buildStoredArtifact(input: CapabilityArtifactWriteInput, now: string): {
    ref: StoredArtifactRef;
    bytes?: string | Uint8Array;
  } {
    const hasContent = input.artifact.content !== undefined;
    const hasExternalUri = Boolean(input.artifact.externalUri);
    if (hasContent === hasExternalUri) {
      throw new Error('capability artifact must include exactly one of content or externalUri');
    }

    const bytes = hasContent
      ? serializeContent(input.artifact.content, input.artifact.mimeType)
      : undefined;
    const hasBytes = bytes !== undefined;
    const contentHash = hasBytes ? sha256(bytes) : undefined;
    const sourceKey = contentHash ?? input.artifact.externalUri;
    const id = sha256(stableJson({
      capabilityId: input.capabilityId,
      delegationId: input.delegationId,
      runId: input.runId,
      kind: input.artifact.kind,
      mimeType: input.artifact.mimeType,
      title: input.artifact.title,
      schema: input.artifact.schema,
      sourceKey,
    }));
    const relativePath = hasBytes ? `${id}${extensionForMimeType(input.artifact.mimeType)}` : undefined;
    const uri = `capability-artifact://thread/${encodeURIComponent(input.threadId)}`
      + `/delegation/${encodeURIComponent(input.delegationId)}`
      + `/artifact/${encodeURIComponent(id)}`;
    return {
      bytes,
      ref: {
        id,
        threadId: input.threadId,
        capabilityId: input.capabilityId,
        delegationId: input.delegationId,
        runId: input.runId,
        kind: input.artifact.kind,
        mimeType: input.artifact.mimeType,
        uri,
        title: input.artifact.title,
        preview: input.artifact.preview,
        sizeBytes: hasBytes ? Buffer.byteLength(bytes) : 0,
        sha256: contentHash,
        externalUri: input.artifact.externalUri,
        createdAt: now,
        schema: input.artifact.schema,
        metadata: {
          ...(input.artifact.metadata ?? {}),
        },
        relativePath,
      },
    };
  }

  async writeArtifact(input: CapabilityArtifactWriteInput): Promise<CapabilityArtifactRef> {
    const [ref] = await this.writeArtifacts([input]);
    return ref;
  }

  async writeArtifacts(inputs: CapabilityArtifactWriteInput[]): Promise<CapabilityArtifactRef[]> {
    const refsByIndex = new Map<number, CapabilityArtifactRef>();
    const groups = new Map<string, Array<{ input: CapabilityArtifactWriteInput; index: number }>>();
    for (const [index, input] of inputs.entries()) {
      const key = `${input.threadId}\n${input.delegationId}`;
      groups.set(key, [...(groups.get(key) ?? []), { input, index }]);
    }

    for (const group of groups.values()) {
      const first = group[0]?.input;
      if (!first) continue;
      const manifestPath = this.manifestPath(first.threadId, first.delegationId);
      await this.withManifestLock(manifestPath, async () => {
        const now = new Date().toISOString();
        const dir = this.delegationDir(first.threadId, first.delegationId);
        const previous = readManifest(manifestPath);
        const manifest: ArtifactManifest = previous ?? {
          version: 1,
          threadId: first.threadId,
          delegationId: first.delegationId,
          runId: first.runId,
          capabilityId: first.capabilityId,
          createdAt: now,
          artifacts: [],
        };
        const nextArtifacts = new Map(manifest.artifacts.map((item) => [item.id, item]));
        for (const item of group) {
          const built = this.buildStoredArtifact(item.input, now);
          if (built.bytes !== undefined && built.ref.relativePath) {
            atomicWriteFile(join(dir, built.ref.relativePath), built.bytes);
          }
          nextArtifacts.set(built.ref.id, built.ref);
          const { relativePath: _relativePath, ...publicRef } = built.ref;
          refsByIndex.set(item.index, publicRef);
        }
        manifest.artifacts = [...nextArtifacts.values()];
        atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
      });
    }

    return inputs.map((_input, index) => {
      const ref = refsByIndex.get(index);
      if (!ref) throw new Error('failed to write capability artifact');
      return ref;
    });
  }

  async listArtifacts(params: {
    threadId: string;
    capabilityId?: string;
    kind?: string;
    limit?: number;
  }): Promise<CapabilityArtifactRef[]> {
    const threadDir = this.threadDir(params.threadId);
    if (!existsSync(threadDir)) return [];
    const refs: StoredArtifactRef[] = [];
    for (const delegationSegment of readdirSync(threadDir)) {
      const manifest = readManifest(join(threadDir, delegationSegment, 'manifest.json'));
      refs.push(...(manifest?.artifacts ?? []));
    }
    return refs
      .filter((ref) => !params.capabilityId || ref.capabilityId === params.capabilityId)
      .filter((ref) => !params.kind || ref.kind === params.kind)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, params.limit ?? 20)
      .map(({ relativePath: _relativePath, ...ref }) => ref);
  }

  async readArtifact(params: {
    uri: string;
    maxBytes?: number;
    threadId?: string;
  }): Promise<{ ref: CapabilityArtifactRef; content: string | null }> {
    const { parsed, stored } = this.readStoredArtifact(params);
    const { relativePath, ...ref } = stored;
    if (!relativePath) {
      return { ref, content: null };
    }
    const path = join(this.delegationDir(parsed.threadId, parsed.delegationId), relativePath);
    if (!isTextReadableMimeType(ref.mimeType)) {
      return { ref, content: null };
    }
    const size = statSync(path).size;
    const maxBytes = params.maxBytes ?? 64_000;
    if (size > maxBytes) {
      return {
        ref,
        content: readUtf8Prefix(path, maxBytes),
      };
    }
    return {
      ref,
      content: readFileSync(path, 'utf-8'),
    };
  }

  async getDownloadUri(uri: string): Promise<string> {
    const { parsed, stored } = this.readStoredArtifact({ uri });
    if (stored.externalUri) {
      return stored.externalUri;
    }
    if (!stored.relativePath) {
      throw new Error('capability artifact has no downloadable content');
    }
    return pathToFileURL(join(
      this.delegationDir(parsed.threadId, parsed.delegationId),
      stored.relativePath,
    )).toString();
  }

  async deleteThreadArtifacts(threadId: string): Promise<void> {
    rmSync(this.threadDir(threadId), { recursive: true, force: true });
  }
}
