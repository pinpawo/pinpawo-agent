import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  TASKS,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId,
  maxChannelVersion,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';

type MemorySaverData = {
  storage: Record<string, Record<string, Record<string, [string, string, string | undefined]>>>;
  writes: Record<string, Record<string, [string, string, string]>>;
};

// Legacy day/thread shard format read only during migration. `bucket` is no
// longer meaningful in the content-addressed layout; it is parsed for
// back-compat and otherwise ignored.
type ThreadShardData = {
  threadId: string;
  bucket: string;
  storage: Record<string, Record<string, [string, string, string | undefined]>>;
  writes: Record<string, Record<string, [string, string, string]>>;
};

type CheckpointManifest = {
  version: 1;
  threadId: string;
  namespace: string;
  checkpointId: string;
  parentCheckpointId?: string;
  checkpointShellHash: string;
  metadataHash: string;
  // Older manifest format: a flat channel->hash map. Still read for back-compat,
  // but new manifests are written with `channelValueRefs` instead.
  channelValueHashes?: Record<string, string>;
  channelValueRefs?: Record<string, ChannelValueRef>;
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
  }>;
};

type SerializedCheckpointTuple = [Uint8Array, Uint8Array, string | undefined];

type ChannelValueRef =
  | { kind: 'object'; hash: string }
  | { kind: 'array'; itemHashes: string[] };

const ROOT_NAMESPACE_SEGMENT = '__root__';

function base64ToUint8(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function generateWriteKey(threadId: string, checkpointNamespace: string | undefined, checkpointId: string) {
  return JSON.stringify([threadId, checkpointNamespace, checkpointId]);
}

function parseWriteKey(key: string): { threadId: string; namespace: string | undefined; checkpointId: string } | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (
      Array.isArray(parsed)
      && typeof parsed[0] === 'string'
      && typeof parsed[2] === 'string'
    ) {
      return {
        threadId: parsed[0],
        namespace: typeof parsed[1] === 'string' ? parsed[1] : undefined,
        checkpointId: parsed[2],
      };
    }
  } catch {
    // ignore malformed keys
  }
  return null;
}

function encodePathSegment(value: string) {
  return encodeURIComponent(value || ROOT_NAMESPACE_SEGMENT);
}

function objectHash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function objectPath(rootDir: string, hash: string) {
  return join(rootDir, 'objects', hash.slice(0, 2), hash.slice(2));
}

function atomicWriteFile(path: string, data: string | Uint8Array) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function safeReadDir(path: string) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function bytesToJson(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString('utf-8')) as unknown;
}

function jsonToBytes(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(value), 'utf-8'));
}

function readObject(rootDir: string, hash: string): Uint8Array {
  return new Uint8Array(readFileSync(objectPath(rootDir, hash)));
}

function isChannelValueRef(value: unknown): value is ChannelValueRef {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (record.kind === 'object' && typeof record.hash === 'string')
    || (record.kind === 'array' && Array.isArray(record.itemHashes) && record.itemHashes.every((hash) => typeof hash === 'string'));
}

/**
 * Content-addressed checkpoint saver.
 *
 * Disk layout:
 *   <base>/objects/ab/cdef...
 *   <base>/threads/<threadId>/refs/<namespace>
 *   <base>/threads/<threadId>/manifests/<namespace>/<checkpointId>.json
 *   <base>/threads/<threadId>/writes/<namespace>/<checkpointId>.json
 *
 * Checkpoint channel values and pending writes are immutable blobs addressed by
 * content hash. Refs are updated only after the referenced manifest and objects
 * are safely written, so a failed write leaves the previous ref readable.
 */
export class FileSaver extends BaseCheckpointSaver {
  private _loadedThreadCount = 0;
  private readonly legacyRootDir: string;
  private readonly legacyBaseName: string;
  private readonly legacyExt: string;
  private readonly casRootDir: string;
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

  constructor(private readonly filePath: string) {
    super();
    this.legacyRootDir = dirname(this.filePath);
    this.legacyExt = extname(this.filePath) || '.json';
    this.legacyBaseName = basename(this.filePath, this.legacyExt);
    this.casRootDir = join(this.legacyRootDir, this.legacyBaseName);
    this.load();
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

  private writeObject(bytes: Uint8Array) {
    const hash = objectHash(bytes);
    const path = objectPath(this.casRootDir, hash);
    if (!existsSync(path)) {
      atomicWriteFile(path, bytes);
    }
    return hash;
  }

  private listLegacyShardFiles() {
    if (!existsSync(this.legacyRootDir)) {
      return [];
    }
    const prefix = `${this.legacyBaseName}.`;
    const legacyFileName = basename(this.filePath);
    return readdirSync(this.legacyRootDir)
      .filter((name) => name !== legacyFileName && name.startsWith(prefix) && name.endsWith(this.legacyExt))
      .map((name) => join(this.legacyRootDir, name));
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

  private readManifest(path: string): CheckpointManifest | null {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as CheckpointManifest;
    } catch {
      return null;
    }
  }

  private readWritesManifest(path: string): WritesManifest | null {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as WritesManifest;
    } catch {
      return null;
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
    const checkpointShell = bytesToJson(readObject(this.casRootDir, manifest.checkpointShellHash));
    const checkpoint = checkpointShell && typeof checkpointShell === 'object'
      ? { ...(checkpointShell as Record<string, unknown>) }
      : {};
    const channelValues: Record<string, unknown> = {};
    for (const [channel, ref] of Object.entries(manifest.channelValueRefs ?? {})) {
      if (!isChannelValueRef(ref)) continue;
      channelValues[channel] = ref.kind === 'array'
        ? ref.itemHashes.map((hash) => bytesToJson(readObject(this.casRootDir, hash)))
        : bytesToJson(readObject(this.casRootDir, ref.hash));
    }
    for (const [channel, hash] of Object.entries(manifest.channelValueHashes ?? {})) {
      if (!(channel in channelValues)) {
        channelValues[channel] = bytesToJson(readObject(this.casRootDir, hash));
      }
    }
    checkpoint.channel_values = channelValues;
    return [
      jsonToBytes(checkpoint),
      readObject(this.casRootDir, manifest.metadataHash),
      manifest.parentCheckpointId,
    ];
  }

  private async pendingWritesFor(threadId: string, namespace: string | undefined, checkpointId: string) {
    const normalizedNamespace = namespace ?? '';
    const manifest = this.readWritesManifest(this.writesPath(threadId, normalizedNamespace, checkpointId));
    if (!manifest) return [];
    const pendingWrites: CheckpointPendingWrite[] = [];
    for (const record of Object.values(manifest.writes ?? {})) {
      pendingWrites.push([
        record.taskId,
        record.channel,
        await this.serde.loadsTyped('json', readObject(this.casRootDir, record.valueHash)),
      ]);
    }
    return pendingWrites;
  }

  private async migratePendingSends(
    mutableCheckpoint: Checkpoint,
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string,
  ) {
    const pendingSends = (await this.pendingWritesFor(threadId, checkpointNs, parentCheckpointId))
      .filter(([_taskId, channel]) => channel === TASKS)
      .map(([_taskId, _channel, value]) => value);
    mutableCheckpoint.channel_values ??= {};
    mutableCheckpoint.channel_values[TASKS] = pendingSends;
    mutableCheckpoint.channel_versions ??= {};
    mutableCheckpoint.channel_versions[TASKS] = Object.keys(mutableCheckpoint.channel_versions).length > 0
      ? maxChannelVersion(...Object.values(mutableCheckpoint.channel_versions))
      : this.getNextVersion(undefined);
  }

  private async tupleFromManifest(manifest: CheckpointManifest, config: RunnableConfig): Promise<CheckpointTuple> {
    const [checkpointBytes, metadataBytes, parentCheckpointId] = this.checkpointTupleBytes(manifest);
    const checkpoint = await this.serde.loadsTyped('json', checkpointBytes) as Checkpoint;
    if (checkpoint.v < 4 && parentCheckpointId !== undefined) {
      await this.migratePendingSends(checkpoint, manifest.threadId, manifest.namespace, parentCheckpointId);
    }
    const checkpointTuple: CheckpointTuple = {
      config,
      checkpoint,
      metadata: await this.serde.loadsTyped('json', metadataBytes),
      pendingWrites: await this.pendingWritesFor(manifest.threadId, manifest.namespace, manifest.checkpointId),
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
        ? { kind: 'array', itemHashes: value.map((item) => this.writeObject(jsonToBytes(item))) }
        : { kind: 'object', hash: this.writeObject(jsonToBytes(value)) };
    }
    checkpointRecord.channel_values = {};

    return {
      version: 1,
      threadId,
      namespace,
      checkpointId,
      ...(tuple[2] ? { parentCheckpointId: tuple[2] } : {}),
      checkpointShellHash: this.writeObject(jsonToBytes(checkpointRecord)),
      metadataHash: this.writeObject(tuple[1]),
      channelValueRefs,
    };
  }

  private writeCheckpointTuple(
    threadId: string,
    namespace: string,
    checkpointId: string,
    tuple: SerializedCheckpointTuple,
  ) {
    mkdirSync(this.casRootDir, { recursive: true });
    const manifest = this.buildCheckpointManifest(threadId, namespace, checkpointId, tuple);
    atomicWriteFile(this.manifestPath(threadId, namespace, checkpointId), JSON.stringify(manifest));
    atomicWriteFile(this.refPath(threadId, namespace), checkpointId);
  }

  private writeWritesManifest(
    threadId: string,
    namespace: string | undefined,
    checkpointId: string,
    outerKey: string,
    writes: Record<string, [string, string, Uint8Array]>,
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
        valueHash: this.writeObject(tuple[2]),
      };
    }
    atomicWriteFile(this.writesPath(threadId, normalizedNamespace, checkpointId), JSON.stringify(writeManifest));
  }

  private migrateLegacyThreadShard(data: ThreadShardData) {
    const threadId = data.threadId;
    if (!threadId) return;
    for (const [namespace, checkpoints] of Object.entries(data.storage ?? {})) {
      for (const [checkpointId, tuple] of Object.entries(checkpoints)) {
        this.writeCheckpointTuple(threadId, namespace, checkpointId, [
          base64ToUint8(tuple[0]),
          base64ToUint8(tuple[1]),
          tuple[2],
        ]);
      }
    }
    for (const [outerKey, writes] of Object.entries(data.writes ?? {})) {
      const parsed = parseWriteKey(outerKey);
      if (!parsed) continue;
      const restored: Record<string, [string, string, Uint8Array]> = {};
      for (const [innerKey, tuple] of Object.entries(writes)) {
        restored[innerKey] = [tuple[0], tuple[1], base64ToUint8(tuple[2])];
      }
      this.writeWritesManifest(parsed.threadId, parsed.namespace, parsed.checkpointId, outerKey, restored);
    }
  }

  private migrateLegacy() {
    const shardFiles = this.listLegacyShardFiles();
    if (shardFiles.length > 0) {
      const migratedFiles: string[] = [];
      for (const file of shardFiles) {
        try {
          const raw = readFileSync(file, 'utf-8');
          this.migrateLegacyThreadShard(JSON.parse(raw) as ThreadShardData);
          migratedFiles.push(file);
        } catch {
          // ignore corrupt shard files
        }
      }
      for (const shardFile of migratedFiles) {
        if (existsSync(shardFile)) {
          unlinkSync(shardFile);
        }
      }
      return;
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as MemorySaverData;
      let migrated = false;
      for (const [threadId, namespaces] of Object.entries(data.storage ?? {})) {
        const threadWrites: Record<string, Record<string, [string, string, string]>> = {};
        for (const [outerKey, writes] of Object.entries(data.writes ?? {})) {
          if (parseWriteKey(outerKey)?.threadId === threadId) {
            threadWrites[outerKey] = writes;
          }
        }
        this.migrateLegacyThreadShard({
          threadId,
          bucket: '',
          storage: namespaces,
          writes: threadWrites,
        });
        migrated = true;
      }
      if (migrated && existsSync(this.filePath)) {
        unlinkSync(this.filePath);
      }
    } catch {
      // No file or corrupt legacy checkpoint store.
    }
  }

  private contentAddressedManifestCount() {
    let count = 0;
    const threadsDir = join(this.casRootDir, 'threads');
    for (const threadSegment of safeReadDir(threadsDir)) {
      const manifestsDir = join(threadsDir, threadSegment, 'manifests');
      for (const namespaceSegment of safeReadDir(manifestsDir)) {
        count += safeReadDir(join(manifestsDir, namespaceSegment)).filter((name) => name.endsWith('.json')).length;
      }
    }
    return count;
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
    if (this.contentAddressedManifestCount() === 0 || this.listLegacyShardFiles().length > 0) {
      this.migrateLegacy();
    }
    this.seedKnownThreads();
    this.gcObjects();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id;
    if (threadId === undefined) return undefined;
    const checkpointNamespace = config.configurable?.checkpoint_ns ?? '';
    const checkpointId = getCheckpointId(config) || this.readLatestCheckpointId(threadId, checkpointNamespace);
    if (!checkpointId) return undefined;
    const manifest = this.readManifest(this.manifestPath(threadId, checkpointNamespace, checkpointId));
    if (!manifest) return undefined;

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
          if (!manifest) continue;
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
      const [, metadataBytes] = this.checkpointTupleBytes(manifest);
      const metadata = await this.serde.loadsTyped('json', metadataBytes) as CheckpointMetadata;
      const metadataRecord = metadata as Record<string, unknown>;
      if (filter && !Object.entries(filter).every(([key, value]) => metadataRecord[key] === value)) {
        continue;
      }
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

    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const [[, serializedCheckpoint], [, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata),
    ]);
    this.writeCheckpointTuple(threadId, checkpointNamespace, checkpoint.id, [
      serializedCheckpoint,
      serializedMetadata,
      config.configurable?.checkpoint_id,
    ]);
    this.noteThread(threadId);
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNamespace,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
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
      const existingManifest = this.readWritesManifest(this.writesPath(threadId, checkpointNamespace ?? '', checkpointId));
      const outerWrites: Record<string, [string, string, Uint8Array]> = {};
      for (const [innerKey, record] of Object.entries(existingManifest?.writes ?? {})) {
        outerWrites[innerKey] = [
          record.taskId,
          record.channel,
          readObject(this.casRootDir, record.valueHash),
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
        ];
      }));

      this.writeWritesManifest(threadId, checkpointNamespace, checkpointId, outerKey, outerWrites);
    });
    this.noteThread(threadId);
  }

  async deleteThread(threadId: string): Promise<void> {
    rmSync(this.threadDir(threadId), { recursive: true, force: true });
    if (this.knownThreads.delete(encodePathSegment(threadId))) {
      this._loadedThreadCount -= 1;
    }
    this.gcObjects();
  }

  flush() {
    // Kept as a no-op compatibility hook for callers that dispose old savers.
  }

  dispose() {
    this.flush();
  }

  private collectReachableObjectHashes() {
    const hashes = new Set<string>();
    const threadsDir = join(this.casRootDir, 'threads');
    for (const threadSegment of safeReadDir(threadsDir)) {
      const threadDir = join(threadsDir, threadSegment);
      const manifestsDir = join(threadDir, 'manifests');
      for (const namespaceSegment of safeReadDir(manifestsDir)) {
        const namespaceDir = join(manifestsDir, namespaceSegment);
        for (const fileName of safeReadDir(namespaceDir)) {
          if (!fileName.endsWith('.json')) continue;
          const manifest = this.readManifest(join(namespaceDir, fileName));
          if (!manifest) continue;
          hashes.add(manifest.checkpointShellHash);
          hashes.add(manifest.metadataHash);
          for (const ref of Object.values(manifest.channelValueRefs ?? {})) {
            if (!isChannelValueRef(ref)) continue;
            if (ref.kind === 'array') {
              for (const hash of ref.itemHashes) {
                hashes.add(hash);
              }
            } else {
              hashes.add(ref.hash);
            }
          }
          for (const hash of Object.values(manifest.channelValueHashes ?? {})) {
            hashes.add(hash);
          }
        }
      }
      const writesDir = join(threadDir, 'writes');
      for (const namespaceSegment of safeReadDir(writesDir)) {
        const namespaceDir = join(writesDir, namespaceSegment);
        for (const fileName of safeReadDir(namespaceDir)) {
          if (!fileName.endsWith('.json')) continue;
          const manifest = this.readWritesManifest(join(namespaceDir, fileName));
          if (!manifest) continue;
          for (const write of Object.values(manifest.writes ?? {})) {
            hashes.add(write.valueHash);
          }
        }
      }
    }
    return hashes;
  }

  // GC walks every manifest to build the reachable set, then deletes any object
  // not in it. This is only invoked from `load()` (constructor) and
  // `deleteThread`. It is NOT safe to run concurrently with `put`/`putWrites`:
  // an object written between collecting the reachable set and the delete pass
  // would look unreachable and be removed. All writers here are synchronous up
  // to their final atomic rename, and the manifest's ref is written last, so
  // within a single FileSaver instance no in-flight put overlaps GC today. Keep
  // it that way — if a writer ever becomes async across the rename, gate GC
  // behind the same lock.
  private gcObjects() {
    const objectsDir = join(this.casRootDir, 'objects');
    if (!existsSync(objectsDir)) return;
    const reachable = this.collectReachableObjectHashes();
    for (const prefix of safeReadDir(objectsDir)) {
      const prefixDir = join(objectsDir, prefix);
      for (const fileName of safeReadDir(prefixDir)) {
        const hash = `${prefix}${fileName}`;
        if (!reachable.has(hash)) {
          rmSync(join(prefixDir, fileName), { force: true });
        }
      }
      if (safeReadDir(prefixDir).length === 0) {
        rmSync(prefixDir, { recursive: true, force: true });
      }
    }
  }
}
