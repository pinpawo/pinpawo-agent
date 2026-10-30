import { parseSessionUsageLedger, updateSessionUsageLedger, type SessionUsageLedger, type UsageCall } from './agent/sessionUsageLedger';
import type { TokenUsageSnapshot } from '@pinpawo/pet-agent';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  copyCheckpoint,
  compareWritesSortKeys,
  writesSortKey,
  getCheckpointId,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import { atomicWriteFile } from './atomicFile';

type CheckpointManifest = {
  version: 1;
  threadId: string;
  namespace: string;
  checkpointId: string;
  parentCheckpointId?: string;
  checkpointShellHash: string;
  metadataHash: string;
  channelValueRefs: Record<string, ChannelValueRef>;
};

type WritesManifest = {
  version: 1;
  threadId: string;
  namespace: string;
  checkpointId: string;
  outerKey: string;
  writes: Record<string, {
    taskId: string;
    channel: string;
    valueHash: string;
    /** Absent on pre-1.5 writes; those sort with the official empty path. */
    taskPath?: string;
    writeIndex?: number;
  }>;
};

type SerializedCheckpointTuple = [Uint8Array, Uint8Array, string | undefined];

type ChannelValueRef =
  | { kind: 'object'; hash: string }
  | { kind: 'array'; itemHashes: string[] };

const ROOT_NAMESPACE_SEGMENT = '__root__';
const HASHED_PATH_SEGMENT_PREFIX = '__sha256__';
// Refs are written through an atomic temporary sibling whose pid/UUID suffix
// also counts against the filesystem's per-component limit (255 on macOS).
// Keep logical identifiers comfortably below that limit without changing the
// existing layout for ordinary thread/checkpoint identifiers.
const MAX_ENCODED_PATH_SEGMENT_LENGTH = 190;
const STORE_LOCK_WAIT_MS = 10;
const STORE_LOCK_TIMEOUT_MS = 30_000;
const STORE_LOCK_ORPHAN_GRACE_MS = 1_000;

type HostWriterLeaseOwner = {
  version: 1;
  pid: number;
  token: string;
  ownerId: string;
  acquiredAt: string;
};

type HostWriterRecoveryOwner = {
  version: 1;
  pid: number;
  token: string;
  previousToken: string;
  acquiredAt: string;
};

function generateWriteKey(threadId: string, checkpointNamespace: string | undefined, checkpointId: string) {
  return JSON.stringify([threadId, checkpointNamespace, checkpointId]);
}

function encodePathSegment(value: string) {
  const encoded = encodeURIComponent(value || ROOT_NAMESPACE_SEGMENT);
  if (
    encoded.length <= MAX_ENCODED_PATH_SEGMENT_LENGTH
    && !encoded.startsWith(HASHED_PATH_SEGMENT_PREFIX)
  ) {
    return encoded;
  }
  return `${HASHED_PATH_SEGMENT_PREFIX}${createHash('sha256').update(value).digest('hex')}`;
}

function objectHash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function objectPath(threadDir: string, hash: string) {
  return join(threadDir, 'objects', hash.slice(0, 2), hash.slice(2));
}

function safeReadDir(path: string) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function isMissingPathError(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Directory listing for GC. Only a missing directory counts as empty; any other
 * read error (EACCES, EIO, ENOTDIR, ...) propagates so GC stops before it can
 * treat an unread directory's references as absent and sweep live objects.
 */
function readDirForGc(path: string) {
  try {
    return readdirSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw new Error(`checkpoint GC could not read directory: ${path}`, { cause: error });
  }
}

/** Child directory names for GC; stray files (e.g. .DS_Store) are not store entries. */
function readSubdirsForGc(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw new Error(`checkpoint GC could not read directory: ${path}`, { cause: error });
  }
}

function bytesToJson(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString('utf-8')) as unknown;
}

function jsonToBytes(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(value), 'utf-8'));
}

function readObject(threadDir: string, hash: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`checkpoint object hash is invalid: ${hash}`);
  }
  const bytes = new Uint8Array(readFileSync(objectPath(threadDir, hash)));
  if (objectHash(bytes) !== hash) {
    throw new Error(`checkpoint object hash mismatch: ${hash}`);
  }
  return bytes;
}

function isChannelValueRef(value: unknown): value is ChannelValueRef {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (record.kind === 'object' && typeof record.hash === 'string')
    || (record.kind === 'array' && Array.isArray(record.itemHashes) && record.itemHashes.every((hash) => typeof hash === 'string'));
}

function isCheckpointManifest(value: unknown): value is CheckpointManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || typeof record.threadId !== 'string'
    || typeof record.namespace !== 'string'
    || typeof record.checkpointId !== 'string'
    || typeof record.checkpointShellHash !== 'string'
    || typeof record.metadataHash !== 'string'
    || (record.parentCheckpointId !== undefined && typeof record.parentCheckpointId !== 'string')
    || !record.channelValueRefs
    || typeof record.channelValueRefs !== 'object'
    || Array.isArray(record.channelValueRefs)
  ) {
    return false;
  }
  return Object.values(record.channelValueRefs).every(isChannelValueRef);
}

function isWritesManifest(value: unknown): value is WritesManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1 || typeof manifest.threadId !== 'string'
    || typeof manifest.namespace !== 'string' || typeof manifest.checkpointId !== 'string'
    || typeof manifest.outerKey !== 'string' || !manifest.writes
    || typeof manifest.writes !== 'object' || Array.isArray(manifest.writes)) return false;
  return Object.entries(manifest.writes).every(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (typeof record.taskId !== 'string' || typeof record.channel !== 'string'
      || typeof record.valueHash !== 'string'
      || (record.taskPath !== undefined && typeof record.taskPath !== 'string')
      || (record.writeIndex !== undefined && !Number.isSafeInteger(record.writeIndex))) return false;
    const prefix = `${record.taskId},`;
    const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : '';
    if (!/^-?\d+$/.test(suffix) || !Number.isSafeInteger(Number(suffix))) return false;
    return record.writeIndex === undefined || record.writeIndex === Number(suffix);
  });
}

function isSupportedCheckpointVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 4;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Content-addressed checkpoint saver.
 *
 * Disk layout:
 *   <base>/threads/<threadId>/objects/ab/cdef...
 *   <base>/threads/<threadId>/refs/<namespace>
 *   <base>/threads/<threadId>/manifests/<namespace>/<checkpointId>.json
 *   <base>/threads/<threadId>/writes/<namespace>/<checkpointId>.json
 *
 * Each thread is self-contained: its objects are shared only by its own
 * namespaces (a subagent's input repeats the main history), never across
 * threads, so deleting a thread is removing its directory and collecting
 * garbage reads only that thread's manifests.
 *
 * Each logical path segment is URI-encoded while it is short and replaced by
 * a deterministic SHA-256 segment when it is long. The manifests retain the
 * original identifiers, so the bounded disk representation is opaque.
 *
 * Checkpoint channel values and pending writes are immutable blobs addressed by
 * content hash. Refs are updated only after the referenced manifest and objects
 * are safely written, so a failed write leaves the previous ref readable.
 *
 * Only the latest checkpoint of each namespace is retained. Nothing in the
 * Host reads checkpoint history (no time travel or state history), and every
 * graph step re-serializes state that can be megabytes, so older manifests and
 * their pending writes are removed once a newer ref is published; the objects
 * they alone referenced are reclaimed by the thread's next GC (after each run
 * via `collectThreadGarbage`, and at Host startup).
 */
export class FileSaver extends BaseCheckpointSaver {
  private _loadedThreadCount = 0;
  private readonly casRootDir: string;
  private readonly storeLockDir: string;
  private readonly hostWriterLeasePath: string;
  private readonly hostWriterRecoveryPath: string;
  private hostWriterLeaseToken: string | null = null;
  /**
   * Per-checkpoint write locks. LangGraph fans out putWrites for multiple tasks
   * against the same checkpoint concurrently; each call read-modify-writes the
   * shared writes manifest, so they must be serialized or one task's writes are
   * lost. The map holds the tail of a promise chain keyed by checkpoint.
   */
  private readonly writeLocks = new Map<string, Promise<void>>();
  /**
   * Threads observed this process lifetime. Lets put/putWrites keep
   * `loadedThreadCount` current without re-reading the threads directory on
   * every checkpoint write.
   */
  private readonly knownThreads = new Set<string>();

  /** Number of threads visible in the content-addressed checkpoint store. */
  get loadedThreadCount() {
    return this._loadedThreadCount;
  }

  /** Record a thread we just wrote to, bumping the count if it is new. */
  private noteThread(threadId: string) {
    const segment = encodePathSegment(threadId);
    if (!this.knownThreads.has(segment)) {
      this.knownThreads.add(segment);
      this._loadedThreadCount += 1;
    }
  }

  constructor(filePath: string) {
    super();
    const extension = extname(filePath) || '.json';
    this.casRootDir = join(dirname(filePath), basename(filePath, extension));
    this.storeLockDir = join(this.casRootDir, '.writer-lock');
    this.hostWriterLeasePath = join(this.casRootDir, '.host-writer.json');
    this.hostWriterRecoveryPath = join(this.casRootDir, '.host-writer-recovery');
    this.load();
  }

  /**
   * Claim this checkpoint root for one Host lifetime.
   *
   * The short-lived store lock below protects individual mutations. This
   * lease is the stronger deployment invariant: two Host processes must not
   * drive the same checkpoint root at the same time.
   */
  acquireHostWriterLease(ownerId: string): void {
    if (this.hostWriterLeaseToken) return;
    mkdirSync(this.casRootDir, { recursive: true });
    const staleRecoveryGuardPath = this.claimStaleRecoveryGuard();

    try {
      const owner: HostWriterLeaseOwner = {
        version: 1,
        pid: process.pid,
        token: randomUUID(),
        ownerId,
        acquiredAt: new Date().toISOString(),
      };
      try {
        writeFileSync(this.hostWriterLeasePath, JSON.stringify(owner), { flag: 'wx' });
        this.hostWriterLeaseToken = owner.token;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      const previous = this.readHostWriterLease();
      if (!previous) {
        throw new Error(
          `Checkpoint writer lease is unreadable; refusing unsafe recovery: ${this.hostWriterLeasePath}`,
        );
      }
      if (isProcessAlive(previous.pid)) {
        throw new Error(
          `Checkpoint root is already owned by ${previous.ownerId} (pid ${previous.pid}): ${this.casRootDir}`,
        );
      }

      const recoveryOwner: HostWriterRecoveryOwner = {
        version: 1,
        pid: process.pid,
        token: randomUUID(),
        previousToken: previous.token,
        acquiredAt: new Date().toISOString(),
      };
      this.publishRecoveryGuard(recoveryOwner);

      try {
        const current = this.readHostWriterLease();
        if (!current || current.token !== previous.token) {
          throw new Error(
            `Checkpoint writer ownership changed during recovery: ${this.hostWriterLeasePath}`,
          );
        }
        if (isProcessAlive(current.pid)) {
          throw new Error(
            `Checkpoint root became active during recovery (pid ${current.pid}): ${this.casRootDir}`,
          );
        }
        rmSync(this.hostWriterLeasePath);
        writeFileSync(this.hostWriterLeasePath, JSON.stringify(owner), { flag: 'wx' });
        this.hostWriterLeaseToken = owner.token;
      } finally {
        this.releaseRecoveryGuard(recoveryOwner.token);
      }
    } finally {
      if (staleRecoveryGuardPath) {
        rmSync(staleRecoveryGuardPath, { recursive: true, force: true });
      }
    }
  }

  /** Run startup maintenance only after this Host owns the checkpoint root. */
  async runHostStartupMaintenance(): Promise<void> {
    const token = this.hostWriterLeaseToken;
    if (!token || this.readHostWriterLease()?.token !== token) {
      throw new Error('Checkpoint startup maintenance requires the Host writer lease.');
    }
    await this.runStoreExclusive(() => {
      const threadDirs = readSubdirsForGc(join(this.casRootDir, 'threads'))
        .map((threadSegment) => join(this.casRootDir, 'threads', threadSegment));
      // Validate every thread before maintenance mutates any of them.
      for (const threadDir of threadDirs) this.collectReachableObjectHashes(threadDir);
      for (const threadDir of threadDirs) {
        this.pruneThreadHistory(threadDir);
        this.gcThreadObjects(threadDir);
      }
    });
  }

  /**
   * Reclaim objects no longer referenced by the thread's retained checkpoints.
   * The Host calls this when a run on the thread settles, so pruned
   * checkpoints do not accumulate objects until the next Host start.
   */
  async collectThreadGarbage(threadId: string): Promise<void> {
    await this.runStoreExclusive(() => this.gcThreadObjects(this.threadDir(threadId)));
  }

  /** Release the Host lifetime claim if this FileSaver still owns it. */
  releaseHostWriterLease(): void {
    const token = this.hostWriterLeaseToken;
    if (!token) return;
    try {
      const owner = this.readHostWriterLease();
      if (owner?.token === token) {
        rmSync(this.hostWriterLeasePath);
      }
    } catch {
      // A missing/replaced lease no longer belongs to this Host.
    } finally {
      this.hostWriterLeaseToken = null;
    }
  }

  private readHostWriterLease(): HostWriterLeaseOwner | null {
    try {
      const parsed = JSON.parse(readFileSync(this.hostWriterLeasePath, 'utf-8')) as Partial<HostWriterLeaseOwner>;
      if (
        parsed.version !== 1
        || typeof parsed.pid !== 'number'
        || typeof parsed.token !== 'string'
        || typeof parsed.ownerId !== 'string'
        || typeof parsed.acquiredAt !== 'string'
      ) {
        return null;
      }
      return parsed as HostWriterLeaseOwner;
    } catch {
      return null;
    }
  }

  private readRecoveryGuard(path = this.hostWriterRecoveryPath): HostWriterRecoveryOwner | null {
    try {
      const parsed = JSON.parse(
        readFileSync(join(path, 'owner.json'), 'utf-8'),
      ) as Partial<HostWriterRecoveryOwner>;
      if (
        parsed.version !== 1
        || typeof parsed.pid !== 'number'
        || typeof parsed.token !== 'string'
        || typeof parsed.previousToken !== 'string'
        || typeof parsed.acquiredAt !== 'string'
      ) {
        return null;
      }
      return parsed as HostWriterRecoveryOwner;
    } catch {
      return null;
    }
  }

  /**
   * Atomically move a dead recovery guard aside before retrying acquisition.
   *
   * The token-derived destination remains present until acquisition finishes.
   * Because both source and destination are non-empty directories, a contender
   * holding a stale view cannot rename a newly published live guard over it.
   */
  private claimStaleRecoveryGuard(): string | null {
    while (existsSync(this.hostWriterRecoveryPath)) {
      const previous = this.readRecoveryGuard();
      if (!previous) {
        if (!existsSync(this.hostWriterRecoveryPath)) {
          continue;
        }
        throw new Error(
          `Checkpoint writer recovery guard is unreadable; refusing unsafe recovery: ${this.hostWriterRecoveryPath}`,
        );
      }
      if (isProcessAlive(previous.pid)) {
        throw new Error(
          `Checkpoint writer ownership recovery is already in progress: ${this.hostWriterRecoveryPath}`,
        );
      }
      const staleToken = createHash('sha256').update(previous.token).digest('hex');
      const stalePath = `${this.hostWriterRecoveryPath}.stale-${staleToken}`;
      try {
        renameSync(this.hostWriterRecoveryPath, stalePath);
        return stalePath;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          continue;
        }
        if (code === 'EEXIST' || code === 'ENOTEMPTY') {
          throw new Error(
            `Checkpoint writer ownership recovery is already in progress: ${this.hostWriterRecoveryPath}`,
          );
        }
        throw error;
      }
    }
    return null;
  }

  /** Publish a fully written recovery guard with one atomic directory rename. */
  private publishRecoveryGuard(owner: HostWriterRecoveryOwner): void {
    const tempPath = `${this.hostWriterRecoveryPath}.tmp-${process.pid}-${randomUUID()}`;
    mkdirSync(tempPath);
    try {
      writeFileSync(join(tempPath, 'owner.json'), JSON.stringify(owner));
      renameSync(tempPath, this.hostWriterRecoveryPath);
    } catch (error) {
      rmSync(tempPath, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        throw new Error(
          `Checkpoint writer ownership recovery is already in progress: ${this.hostWriterRecoveryPath}`,
        );
      }
      throw error;
    }
  }

  private releaseRecoveryGuard(token: string): void {
    try {
      if (this.readRecoveryGuard()?.token === token) {
        rmSync(this.hostWriterRecoveryPath, { recursive: true, force: true });
      }
    } catch {
      // A missing/replaced recovery guard is no longer ours to release.
    }
  }

  /**
   * Atomic renames protect individual files, but `putWrites` and GC are
   * multi-file transactions, so a filesystem lock covers each store mutation.
   * Host-level process ownership is enforced separately by the lifetime lease.
   */
  private async runStoreExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const token = `${process.pid}:${randomUUID()}`;
    const startedAt = Date.now();
    mkdirSync(this.casRootDir, { recursive: true });
    while (true) {
      try {
        mkdirSync(this.storeLockDir, { recursive: false });
        writeFileSync(
          join(this.storeLockDir, 'owner.json'),
          JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }),
        );
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;
        this.removeStaleStoreLock();
        if (Date.now() - startedAt >= STORE_LOCK_TIMEOUT_MS) {
          throw new Error(
            `Timed out waiting for checkpoint store writer lock: ${this.storeLockDir}`,
          );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, STORE_LOCK_WAIT_MS));
      }
    }

    try {
      return await fn();
    } finally {
      // Only the owner may release. A stale-lock recovery can replace the lock
      // while an unusually long old writer is still unwinding.
      try {
        const owner = JSON.parse(
          readFileSync(join(this.storeLockDir, 'owner.json'), 'utf-8'),
        ) as { token?: unknown };
        if (owner.token === token) {
          rmSync(this.storeLockDir, { recursive: true, force: true });
        }
      } catch {
        // Missing/replaced lock is already released from this owner's view.
      }
    }
  }

  private removeStaleStoreLock(): void {
    try {
      const owner = JSON.parse(
        readFileSync(join(this.storeLockDir, 'owner.json'), 'utf-8'),
      ) as { pid?: unknown };
      if (typeof owner.pid === 'number') {
        try {
          process.kill(owner.pid, 0);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
        }
        // The owning process no longer exists; recover immediately.
        rmSync(this.storeLockDir, { recursive: true, force: true });
        return;
      }
    } catch {
      // The owner file may be between mkdir and publication. Give that tiny
      // synchronous window a grace period before treating it as orphaned.
    }

    try {
      if (
        Date.now() - statSync(this.storeLockDir).mtimeMs
        >= STORE_LOCK_ORPHAN_GRACE_MS
      ) {
        rmSync(this.storeLockDir, { recursive: true, force: true });
      }
    } catch {
      // Another writer released or recovered it first.
    }
  }

  /** Serialize `fn` against others sharing `key` (a promise-chain mutex). */
  private async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(key) ?? Promise.resolve();
    const run = previous.then(() => fn());
    // Keep the chain alive even if `fn` rejects, so a failure does not wedge
    // every later waiter on this key.
    const tail = run.then(() => undefined, () => undefined);
    this.writeLocks.set(key, tail);
    try {
      return await run;
    } finally {
      // Drop the entry once we are the last in line, so the map does not grow
      // unbounded across distinct checkpoints.
      if (this.writeLocks.get(key) === tail) {
        this.writeLocks.delete(key);
      }
    }
  }

  private writeObject(threadDir: string, bytes: Uint8Array) {
    const hash = objectHash(bytes);
    const path = objectPath(threadDir, hash);
    if (!existsSync(path)) {
      atomicWriteFile(path, bytes);
    }
    return hash;
  }

  private threadDir(threadId: string) {
    return join(this.casRootDir, 'threads', encodePathSegment(threadId));
  }

  private manifestPath(threadId: string, namespace: string, checkpointId: string) {
    return join(
      this.threadDir(threadId),
      'manifests',
      encodePathSegment(namespace),
      `${encodePathSegment(checkpointId)}.json`,
    );
  }

  private writesPath(threadId: string, namespace: string, checkpointId: string) {
    return join(
      this.threadDir(threadId),
      'writes',
      encodePathSegment(namespace),
      `${encodePathSegment(checkpointId)}.json`,
    );
  }

  private refPath(threadId: string, namespace: string) {
    return join(this.threadDir(threadId), 'refs', encodePathSegment(namespace));
  }

  private readManifest(path: string): CheckpointManifest {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    } catch (error) {
      throw new Error(`checkpoint manifest is unreadable: ${path}`, { cause: error });
    }
    if (!isCheckpointManifest(parsed)) {
      throw new Error(`checkpoint manifest uses an unsupported format: ${path}`);
    }
    return parsed;
  }

  private readWritesManifest(path: string): WritesManifest | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
      if (!isWritesManifest(parsed)) throw new Error('unsupported writes manifest format');
      return parsed;
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw new Error(`checkpoint writes manifest is unreadable: ${path}`, { cause: error });
    }
  }

  /** GC variant of readWritesManifest: an unreadable manifest aborts GC instead of dropping its references. */
  private readWritesManifestForGc(path: string): WritesManifest {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
      if (!isWritesManifest(parsed)) throw new Error('unsupported writes manifest format');
      return parsed;
    } catch (error) {
      throw new Error(`checkpoint writes manifest is unreadable: ${path}`, { cause: error });
    }
  }

  private readLatestCheckpointId(threadId: string, namespace: string) {
    try {
      const checkpointId = readFileSync(this.refPath(threadId, namespace), 'utf-8').trim();
      return checkpointId || undefined;
    } catch {
      return undefined;
    }
  }

  private checkpointTupleBytes(manifest: CheckpointManifest): SerializedCheckpointTuple {
    const threadDir = this.threadDir(manifest.threadId);
    const checkpointShell = bytesToJson(readObject(threadDir, manifest.checkpointShellHash));
    const checkpoint = checkpointShell && typeof checkpointShell === 'object'
      ? { ...(checkpointShell as Record<string, unknown>) }
      : {};
    const channelValues: Record<string, unknown> = {};
    for (const [channel, ref] of Object.entries(manifest.channelValueRefs)) {
      if (!isChannelValueRef(ref)) continue;
      channelValues[channel] = ref.kind === 'array'
        ? ref.itemHashes.map((hash) => bytesToJson(readObject(threadDir, hash)))
        : bytesToJson(readObject(threadDir, ref.hash));
    }
    checkpoint.channel_values = channelValues;
    return [
      jsonToBytes(checkpoint),
      readObject(threadDir, manifest.metadataHash),
      manifest.parentCheckpointId,
    ];
  }

  private pendingWriteBytesFor(manifest: CheckpointManifest): [string, string, Uint8Array][] {
    const writes = this.readWritesManifest(this.writesPath(manifest.threadId, manifest.namespace, manifest.checkpointId));
    const threadDir = this.threadDir(manifest.threadId);
    return Object.entries(writes?.writes ?? {})
      .map(([key, record]) => ({
        record,
        // Legacy manifests encoded the index after the last comma in the key.
        sortKey: writesSortKey(record.taskPath ?? '', record.taskId,
          record.writeIndex ?? Number(key.slice(key.lastIndexOf(',') + 1))),
      }))
      .sort((a, b) => compareWritesSortKeys(a.sortKey, b.sortKey))
      .map(({ record }) => [record.taskId, record.channel, readObject(threadDir, record.valueHash)]);
  }

  /**
   * Read every byte a checkpoint tuple needs before the first await. A newer
   * checkpoint can prune this one and the run-end GC can then delete its
   * objects while a reader is suspended in deserialization; synchronous reads
   * cannot interleave with them in this process.
   */
  private async tupleFromManifest(manifest: CheckpointManifest, config: RunnableConfig): Promise<CheckpointTuple> {
    const [checkpointBytes, metadataBytes, parentCheckpointId] = this.checkpointTupleBytes(manifest);
    const pendingWriteBytes = this.pendingWriteBytesFor(manifest);
    const checkpoint = await this.serde.loadsTyped('json', checkpointBytes) as Checkpoint;
    if (!isSupportedCheckpointVersion(checkpoint.v)) {
      throw new Error(`checkpoint ${manifest.checkpointId} uses unsupported version ${checkpoint.v}`);
    }
    const pendingWrites: CheckpointPendingWrite[] = [];
    for (const [taskId, channel, bytes] of pendingWriteBytes) {
      pendingWrites.push([taskId, channel, await this.serde.loadsTyped('json', bytes)]);
    }
    const checkpointTuple: CheckpointTuple = {
      config,
      checkpoint,
      metadata: await this.serde.loadsTyped('json', metadataBytes),
      pendingWrites,
    };
    if (parentCheckpointId !== undefined) {
      checkpointTuple.parentConfig = {
        configurable: {
          thread_id: manifest.threadId,
          checkpoint_ns: manifest.namespace,
          checkpoint_id: parentCheckpointId,
        },
      };
    }
    return checkpointTuple;
  }

  private buildCheckpointManifest(
    threadId: string,
    namespace: string,
    checkpointId: string,
    tuple: SerializedCheckpointTuple,
  ): CheckpointManifest {
    const threadDir = this.threadDir(threadId);
    const checkpoint = bytesToJson(tuple[0]);
    const checkpointRecord = checkpoint && typeof checkpoint === 'object'
      ? { ...(checkpoint as Record<string, unknown>) }
      : {};
    const rawChannelValues = checkpointRecord.channel_values;
    const channelValues = rawChannelValues && typeof rawChannelValues === 'object' && !Array.isArray(rawChannelValues)
      ? rawChannelValues as Record<string, unknown>
      : {};
    const channelValueRefs: Record<string, ChannelValueRef> = {};
    for (const [channel, value] of Object.entries(channelValues)) {
      channelValueRefs[channel] = Array.isArray(value)
        ? { kind: 'array', itemHashes: value.map((item) => this.writeObject(threadDir, jsonToBytes(item))) }
        : { kind: 'object', hash: this.writeObject(threadDir, jsonToBytes(value)) };
    }
    checkpointRecord.channel_values = {};

    return {
      version: 1,
      threadId,
      namespace,
      checkpointId,
      ...(tuple[2] ? { parentCheckpointId: tuple[2] } : {}),
      checkpointShellHash: this.writeObject(threadDir, jsonToBytes(checkpointRecord)),
      metadataHash: this.writeObject(threadDir, tuple[1]),
      channelValueRefs,
    };
  }

  private writeCheckpointTuple(
    threadId: string,
    namespace: string,
    checkpointId: string,
    tuple: SerializedCheckpointTuple,
  ) {
    // A malformed older manifest or broken object reference must not be
    // hidden by advancing the ref and pruning its only recovery evidence.
    this.collectReachableObjectHashes(this.threadDir(threadId));
    mkdirSync(this.casRootDir, { recursive: true });
    const manifest = this.buildCheckpointManifest(threadId, namespace, checkpointId, tuple);
    atomicWriteFile(this.manifestPath(threadId, namespace, checkpointId), JSON.stringify(manifest));
    atomicWriteFile(this.refPath(threadId, namespace), checkpointId);
    this.pruneNamespace(this.threadDir(threadId), encodePathSegment(namespace), checkpointId);
  }

  /**
   * Remove the manifests and writes manifests in a namespace that the published
   * `latestCheckpointId` supersedes. Called only after that ref is published.
   *
   * Only older checkpoints are removed. Under LangGraph's async durability only
   * `put` calls are queued behind each other; `putWrites` for a newer
   * checkpoint (e.g. its `__interrupt__`) can land before an older `put`
   * publishes, and those writes must survive until their own checkpoint does.
   * Like `list()`'s `before`, this relies on checkpoint ids sorting by time.
   */
  private pruneNamespace(threadDir: string, namespaceSegment: string, latestCheckpointId: string) {
    const keep = `${encodePathSegment(latestCheckpointId)}.json`;
    const obsolete: string[] = [];
    for (const kind of ['manifests', 'writes']) {
      const namespaceDir = join(threadDir, kind, namespaceSegment);
      for (const fileName of readDirForGc(namespaceDir)) {
        if (!fileName.endsWith('.json')) continue;
        const path = join(namespaceDir, fileName);
        const manifest = kind === 'manifests' ? this.readManifest(path) : this.readWritesManifestForGc(path);
        if (fileName !== keep && manifest.checkpointId < latestCheckpointId) obsolete.push(path);
      }
    }
    for (const path of obsolete) rmSync(path, { force: true });
  }

  /**
   * Startup pass that applies the latest-only retention to stores written
   * before it existed (or left a stale writes manifest behind a late putWrites
   * for an already superseded checkpoint).
   * A namespace whose ref is missing or unreadable is left untouched.
   */
  private pruneThreadHistory(threadDir: string) {
    for (const namespaceSegment of readDirForGc(join(threadDir, 'refs'))) {
      // Leftover atomic-write temp files are dot-prefixed; they are not refs.
      if (namespaceSegment.startsWith('.')) continue;
      let latestCheckpointId: string;
      try {
        latestCheckpointId = readFileSync(join(threadDir, 'refs', namespaceSegment), 'utf-8').trim();
      } catch {
        continue;
      }
      if (!latestCheckpointId) continue;
      if (!existsSync(join(threadDir, 'manifests', namespaceSegment, `${encodePathSegment(latestCheckpointId)}.json`))) {
        continue;
      }
      this.pruneNamespace(threadDir, namespaceSegment, latestCheckpointId);
    }
  }

  private writeWritesManifest(
    threadId: string,
    namespace: string | undefined,
    checkpointId: string,
    outerKey: string,
    writes: Record<string, [string, string, Uint8Array, string, number]>,
  ) {
    const normalizedNamespace = namespace ?? '';
    const writeManifest: WritesManifest = {
      version: 1,
      threadId,
      namespace: normalizedNamespace,
      checkpointId,
      outerKey,
      writes: {},
    };
    for (const [innerKey, tuple] of Object.entries(writes)) {
      writeManifest.writes[innerKey] = {
        taskId: tuple[0],
        channel: tuple[1],
        valueHash: this.writeObject(this.threadDir(threadId), tuple[2]),
        taskPath: tuple[3],
        writeIndex: tuple[4],
      };
    }
    atomicWriteFile(this.writesPath(threadId, normalizedNamespace, checkpointId), JSON.stringify(writeManifest));
  }

  /** Re-scan the threads directory and reset the known-thread set + count. */
  private seedKnownThreads() {
    const threadsDir = join(this.casRootDir, 'threads');
    this.knownThreads.clear();
    for (const threadSegment of safeReadDir(threadsDir)) {
      try {
        if (statSync(join(threadsDir, threadSegment)).isDirectory()) {
          this.knownThreads.add(threadSegment);
        }
      } catch {
        // skip entries we cannot stat
      }
    }
    this._loadedThreadCount = this.knownThreads.size;
  }

  private load() {
    this.seedKnownThreads();
    // Validate existing manifests, but do not delete objects during constructor
    // startup: constructors cannot await the cross-process writer lock. The
    // owning Host runs startup GC after acquiring its lifetime writer lease.
    for (const threadSegment of readSubdirsForGc(join(this.casRootDir, 'threads'))) {
      this.collectReachableObjectHashes(join(this.casRootDir, 'threads', threadSegment));
    }
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    if (threadId === undefined) return undefined;
    const checkpointNamespace = config.configurable?.checkpoint_ns ?? '';
    const checkpointId = getCheckpointId(config) || this.readLatestCheckpointId(threadId, checkpointNamespace);
    if (!checkpointId) return undefined;
    const manifestPath = this.manifestPath(threadId, checkpointNamespace, checkpointId);
    if (!existsSync(manifestPath)) return undefined;
    const manifest = this.readManifest(manifestPath);

    return this.tupleFromManifest(manifest, {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpointId,
      },
    });
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    let { before, limit, filter } = options ?? {};
    const threadsDir = join(this.casRootDir, 'threads');
    const requestedThreadIds = config.configurable?.thread_id ? [config.configurable.thread_id] : undefined;
    const requestedNamespace = config.configurable?.checkpoint_ns;
    const requestedCheckpointId = config.configurable?.checkpoint_id;

    const manifests: CheckpointManifest[] = [];
    const threadSegments = requestedThreadIds?.map(encodePathSegment) ?? safeReadDir(threadsDir);
    for (const threadSegment of threadSegments) {
      const manifestsDir = join(threadsDir, threadSegment, 'manifests');
      for (const namespaceSegment of safeReadDir(manifestsDir)) {
        const namespaceDir = join(manifestsDir, namespaceSegment);
        for (const fileName of safeReadDir(namespaceDir)) {
          if (!fileName.endsWith('.json')) continue;
          const manifest = this.readManifest(join(namespaceDir, fileName));
          if (requestedThreadIds && !requestedThreadIds.includes(manifest.threadId)) continue;
          if (requestedNamespace !== undefined && manifest.namespace !== requestedNamespace) continue;
          if (requestedCheckpointId && manifest.checkpointId !== requestedCheckpointId) continue;
          if (before?.configurable?.checkpoint_id && manifest.checkpointId >= before.configurable.checkpoint_id) continue;
          manifests.push(manifest);
        }
      }
    }

    // Newest first. Relies on LangGraph checkpoint ids being lexicographically
    // time-ordered (sortable UUIDs), the same assumption `before` filtering uses.
    manifests.sort((a, b) => b.checkpointId.localeCompare(a.checkpointId));
    for (const manifest of manifests) {
      // A checkpoint pruned since the scan (its objects possibly collected) is
      // no longer part of the history.
      if (!existsSync(this.manifestPath(manifest.threadId, manifest.namespace, manifest.checkpointId))) continue;
      const [, metadataBytes] = this.checkpointTupleBytes(manifest);
      const metadata = await this.serde.loadsTyped('json', metadataBytes) as CheckpointMetadata;
      const metadataRecord = metadata as Record<string, unknown>;
      if (filter && !Object.entries(filter).every(([key, value]) => metadataRecord[key] === value)) {
        continue;
      }
      // Checked again: deserializing metadata yields to other work.
      if (!existsSync(this.manifestPath(manifest.threadId, manifest.namespace, manifest.checkpointId))) continue;
      if (limit !== undefined) {
        if (limit <= 0) break;
        limit -= 1;
      }
      yield this.tupleFromManifest(manifest, {
        configurable: {
          thread_id: manifest.threadId,
          checkpoint_ns: manifest.namespace,
          checkpoint_id: manifest.checkpointId,
        },
      });
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns ?? '';
    if (threadId === undefined) {
      throw new Error('Failed to put checkpoint. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property. When using a checkpointer, you must pass a "thread_id" so the checkpointer knows which conversation thread to persist state for. Example: graph.stream(input, { configurable: { thread_id: "my-thread-id" } })');
    }
    if (!isSupportedCheckpointVersion(checkpoint.v)) {
      throw new Error(`Failed to put checkpoint. Version ${checkpoint.v} is unsupported; FileSaver requires v4 or newer.`);
    }

    for (const channel of Object.keys(metadata.counters_since_delta_snapshot ?? {})) {
      if (checkpoint.channel_versions[channel] !== undefined
        && !Object.hasOwn(checkpoint.channel_values, channel)) {
        throw new Error(`FileSaver's latest-only retention cannot persist DeltaChannel "${channel}" without a snapshot. Use a full-history saver or ensure this channel is snapshotted in every checkpoint.`);
      }
    }
    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const [[, serializedCheckpoint], [, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata),
    ]);
    await this.runStoreExclusive(() => {
      this.writeCheckpointTuple(threadId, checkpointNamespace, checkpoint.id, [
        serializedCheckpoint,
        serializedMetadata,
        config.configurable?.checkpoint_id,
      ]);
      this.noteThread(threadId);
    });
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath = ''): Promise<void> {
    const threadId = config.configurable?.thread_id;
    const checkpointNamespace = config.configurable?.checkpoint_ns;
    const checkpointId = config.configurable?.checkpoint_id;
    if (threadId === undefined) {
      throw new Error('Failed to put writes. The passed RunnableConfig is missing a required "thread_id" field in its "configurable" property. When using a checkpointer, you must pass a "thread_id" so the checkpointer knows which conversation thread to persist state for. Example: graph.stream(input, { configurable: { thread_id: "my-thread-id" } })');
    }
    if (checkpointId === undefined) {
      throw new Error('Failed to put writes. The passed RunnableConfig is missing a required "checkpoint_id" field in its "configurable" property.');
    }

    const outerKey = generateWriteKey(threadId, checkpointNamespace, checkpointId);

    // Serialize the read-modify-write so concurrent putWrites for sibling tasks
    // on the same checkpoint do not clobber each other's writes manifest.
    await this.runExclusive(outerKey, async () => {
      await this.runStoreExclusive(async () => {
        const existingManifest = this.readWritesManifest(this.writesPath(threadId, checkpointNamespace ?? '', checkpointId));
        const outerWrites: Record<string, [string, string, Uint8Array, string, number]> = {};
        for (const [innerKey, record] of Object.entries(existingManifest?.writes ?? {})) {
          outerWrites[innerKey] = [
            record.taskId,
            record.channel,
            readObject(this.threadDir(threadId), record.valueHash),
            record.taskPath ?? '',
            record.writeIndex ?? Number(innerKey.slice(innerKey.lastIndexOf(',') + 1)),
          ];
        }

        await Promise.all(writes.map(async ([channel, value], idx) => {
          const [, serializedValue] = await this.serde.dumpsTyped(value);
          const writeIndex = WRITES_IDX_MAP[channel] ?? idx;
          const innerKeyStr = `${taskId},${writeIndex}`;
          if (writeIndex >= 0 && innerKeyStr in outerWrites) return;
          outerWrites[innerKeyStr] = [
            taskId,
            channel,
            serializedValue,
            taskPath,
            writeIndex,
          ];
        }));

        this.writeWritesManifest(threadId, checkpointNamespace, checkpointId, outerKey, outerWrites);
      });
    });
    this.noteThread(threadId);
  }

  readSessionUsage(threadId: string): SessionUsageLedger | null {
    const path = join(this.threadDir(threadId), 'usage.json');
    if (!existsSync(path)) return null;
    try {
      return parseSessionUsageLedger(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      // Accounting must never block loading a session. An unreadable ledger is
      // treated as absent: the next run imports retained transcript usage as an
      // incomplete baseline and overwrites this file.
      return null;
    }
  }

  async putSessionUsageCall(threadId: string, id: string, call: UsageCall, baseline?: TokenUsageSnapshot): Promise<void> {
    await this.runStoreExclusive(() => {
      const previous = this.readSessionUsage(threadId);
      const ledger = updateSessionUsageLedger(previous, id, call, baseline);
      if (ledger !== previous) atomicWriteFile(join(this.threadDir(threadId), 'usage.json'), JSON.stringify(ledger));
    });
  }

  override async getDeltaChannelHistory(options: Parameters<BaseCheckpointSaver['getDeltaChannelHistory']>[0]) {
    if (options.channels.length === 0) return {};
    throw new Error('FileSaver cannot reconstruct DeltaChannel history: latest-only retention does not preserve ancestor writes. Use a full-history saver or ensure this channel is snapshotted in every checkpoint.');
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.runStoreExclusive(() => {
      rmSync(this.threadDir(threadId), { recursive: true, force: true });
      if (this.knownThreads.delete(encodePathSegment(threadId))) {
        this._loadedThreadCount -= 1;
      }
    });
  }

  private collectReachableObjectHashes(threadDir: string) {
    const hashes = new Set<string>();
    const manifestsDir = join(threadDir, 'manifests');
    for (const namespaceSegment of readSubdirsForGc(manifestsDir)) {
      const namespaceDir = join(manifestsDir, namespaceSegment);
      for (const fileName of readDirForGc(namespaceDir)) {
        if (!fileName.endsWith('.json')) continue;
        const manifest = this.readManifest(join(namespaceDir, fileName));
        if (encodePathSegment(manifest.threadId) !== basename(threadDir)
          || encodePathSegment(manifest.namespace) !== namespaceSegment
          || `${encodePathSegment(manifest.checkpointId)}.json` !== fileName) {
          throw new Error(`checkpoint manifest identity does not match its path: ${join(namespaceDir, fileName)}`);
        }
        hashes.add(manifest.checkpointShellHash);
        hashes.add(manifest.metadataHash);
        for (const ref of Object.values(manifest.channelValueRefs)) {
          if (!isChannelValueRef(ref)) continue;
          if (ref.kind === 'array') {
            for (const hash of ref.itemHashes) {
              hashes.add(hash);
            }
          } else {
            hashes.add(ref.hash);
          }
        }
      }
    }
    const writesDir = join(threadDir, 'writes');
    for (const namespaceSegment of readSubdirsForGc(writesDir)) {
      const namespaceDir = join(writesDir, namespaceSegment);
      for (const fileName of readDirForGc(namespaceDir)) {
        if (!fileName.endsWith('.json')) continue;
        const manifest = this.readWritesManifestForGc(join(namespaceDir, fileName));
        if (encodePathSegment(manifest.threadId) !== basename(threadDir)
          || encodePathSegment(manifest.namespace) !== namespaceSegment
          || `${encodePathSegment(manifest.checkpointId)}.json` !== fileName) {
          throw new Error(`checkpoint writes manifest identity does not match its path: ${join(namespaceDir, fileName)}`);
        }
        for (const write of Object.values(manifest.writes ?? {})) {
          hashes.add(write.valueHash);
        }
      }
    }
    // Validate all reachable objects before any pruning or sweep starts. A
    // syntactically valid but missing/corrupt reference cannot mark the real
    // object as garbage and then delete it.
    for (const hash of hashes) readObject(threadDir, hash);
    return hashes;
  }

  // GC walks every manifest of the thread to build the reachable set, then
  // deletes any of its objects not in it. A scan that cannot read part of the
  // thread throws before any delete (#928): skipping an unreadable directory
  // would leave its references out of the reachable set. Callers must hold the
  // store-wide filesystem lock so a concurrent write cannot publish an object
  // between the reachability scan and delete.
  private gcThreadObjects(threadDir: string) {
    const objectsDir = join(threadDir, 'objects');
    if (!existsSync(objectsDir)) return;
    const reachable = this.collectReachableObjectHashes(threadDir);
    for (const prefix of readSubdirsForGc(objectsDir)) {
      const prefixDir = join(objectsDir, prefix);
      for (const fileName of readDirForGc(prefixDir)) {
        const hash = `${prefix}${fileName}`;
        if (!reachable.has(hash)) {
          rmSync(join(prefixDir, fileName), { force: true });
        }
      }
      if (readDirForGc(prefixDir).length === 0) {
        rmdirSync(prefixDir);
      }
    }
  }
}
