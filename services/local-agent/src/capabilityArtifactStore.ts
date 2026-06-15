import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type {
  CapabilityArtifactRef,
  CapabilityArtifactStore,
  CapabilityArtifactWriteInput,
} from '@pinpawo/pet-agent';

export const DEFAULT_CAPABILITY_ARTIFACT_ROOT = resolve(homedir(), '.pinpawo', 'capability-artifacts');

type StoredArtifactRef = CapabilityArtifactRef & {
  relativePath?: string;
};

type ArtifactManifest = {
  version: 1;
  threadId: string;
  delegationId: string;
  turnId: string;
  capabilityId: string;
  createdAt: string;
  artifacts: StoredArtifactRef[];
};

function encodePathSegment(value: string) {
  return encodeURIComponent(value || '__empty__');
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

function serializeContent(content: unknown, mimeType: string) {
  if (typeof content === 'string') return content;
  if (content === undefined) return '';
  return mimeType === 'application/json'
    ? JSON.stringify(content, null, 2)
    : String(content);
}

function readManifest(path: string): ArtifactManifest | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as ArtifactManifest;
    return Array.isArray(record.artifacts) ? record : null;
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

export class FileCapabilityArtifactStore implements CapabilityArtifactStore {
  constructor(private readonly rootDir = DEFAULT_CAPABILITY_ARTIFACT_ROOT) {}

  private threadDir(threadId: string) {
    return join(this.rootDir, 'threads', encodePathSegment(threadId));
  }

  private delegationDir(threadId: string, delegationId: string) {
    return join(this.threadDir(threadId), encodePathSegment(delegationId));
  }

  private manifestPath(threadId: string, delegationId: string) {
    return join(this.delegationDir(threadId, delegationId), 'manifest.json');
  }

  async writeArtifact(input: CapabilityArtifactWriteInput): Promise<CapabilityArtifactRef> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const dir = this.delegationDir(input.threadId, input.delegationId);
    const relativePath = input.marker.content !== undefined
      ? `${id}${extensionForMimeType(input.marker.mimeType)}`
      : undefined;
    const content = serializeContent(input.marker.content, input.marker.mimeType);
    if (relativePath) {
      atomicWriteFile(join(dir, relativePath), content);
    }
    const uri = `capability-artifact://thread/${encodeURIComponent(input.threadId)}`
      + `/delegation/${encodeURIComponent(input.delegationId)}`
      + `/artifact/${encodeURIComponent(id)}`;
    const ref: StoredArtifactRef = {
      id,
      threadId: input.threadId,
      capabilityId: input.capabilityId,
      delegationId: input.delegationId,
      turnId: input.turnId,
      kind: input.marker.kind,
      mimeType: input.marker.mimeType,
      uri,
      title: input.marker.title,
      preview: input.marker.preview,
      sizeBytes: relativePath ? Buffer.byteLength(content, 'utf-8') : 0,
      sha256: relativePath ? sha256(content) : undefined,
      createdAt: now,
      schema: input.marker.schema,
      metadata: {
        ...(input.marker.metadata ?? {}),
        ...(input.marker.sourceUri ? { sourceUri: input.marker.sourceUri } : {}),
        ...(input.marker.existingUri ? { existingUri: input.marker.existingUri } : {}),
      },
      relativePath,
    };
    const manifestPath = this.manifestPath(input.threadId, input.delegationId);
    const previous = readManifest(manifestPath);
    const manifest: ArtifactManifest = previous ?? {
      version: 1,
      threadId: input.threadId,
      delegationId: input.delegationId,
      turnId: input.turnId,
      capabilityId: input.capabilityId,
      createdAt: now,
      artifacts: [],
    };
    manifest.artifacts = [
      ...manifest.artifacts.filter((item) => item.id !== id),
      ref,
    ];
    atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
    const { relativePath: _relativePath, ...publicRef } = ref;
    return publicRef;
  }

  listArtifacts(params: {
    threadId: string;
    capabilityId?: string;
    kind?: string;
    limit?: number;
  }): CapabilityArtifactRef[] {
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

  readArtifact(params: {
    uri: string;
    maxBytes?: number;
    threadId?: string;
  }): { ref: CapabilityArtifactRef; content: string | null } {
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
    const { relativePath, ...ref } = stored;
    if (!relativePath) {
      return { ref, content: null };
    }
    const path = join(this.delegationDir(parsed.threadId, parsed.delegationId), relativePath);
    const size = statSync(path).size;
    const maxBytes = params.maxBytes ?? 64_000;
    if (size > maxBytes) {
      return {
        ref,
        content: readFileSync(path).subarray(0, maxBytes).toString('utf-8'),
      };
    }
    return {
      ref,
      content: readFileSync(path, 'utf-8'),
    };
  }
}
