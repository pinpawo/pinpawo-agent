import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { MemorySaver } from '@langchain/langgraph-checkpoint';

type MemorySaverData = {
  storage: Record<string, Record<string, Record<string, [string, string, string | undefined]>>>;
  writes: Record<string, Record<string, [string, string, string]>>;
};

type ThreadShardData = {
  threadId: string;
  bucket: string;
  storage: Record<string, Record<string, [string, string, string | undefined]>>;
  writes: Record<string, Record<string, [string, string, string]>>;
};

function uint8ToBase64(u8: Uint8Array): string {
  return Buffer.from(u8).toString('base64');
}

function base64ToUint8(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function formatDateBucket(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseWriteThreadId(key: string): string | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[0]) {
      return parsed[0];
    }
  } catch {
    // ignore malformed keys
  }
  return null;
}

/**
 * MemorySaver with file-based persistence.
 * Periodically flushes to disk and saves on process exit.
 *
 * Checkpoints are sharded by day and thread so one oversized conversation
 * does not force us to stringify the whole in-memory store into a single file.
 */
export class FileSaver extends MemorySaver {
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private exitHandler: (() => void) | null = null;
  private _loadedThreadCount = 0;
  private readonly shardRootDir: string;
  private readonly shardBaseName: string;
  private readonly shardExt: string;
  private readonly threadBuckets = new Map<string, string>();
  private readonly knownShardFiles = new Map<string, string>();

  /** Number of threads restored from file. */
  get loadedThreadCount() {
    return this._loadedThreadCount;
  }

  constructor(
    private readonly filePath: string,
    private readonly flushIntervalMs = 30_000,
  ) {
    super();
    this.shardRootDir = dirname(this.filePath);
    this.shardExt = extname(this.filePath) || '.json';
    this.shardBaseName = basename(this.filePath, this.shardExt);
    this.load();
    this.startAutoFlush();
  }

  // --- Override put/putWrites to mark dirty ---

  override async put(
    ...args: Parameters<MemorySaver['put']>
  ): ReturnType<MemorySaver['put']> {
    const result = await super.put(...args);
    this.noteThreadBucket(args[0]?.configurable?.thread_id);
    this.dirty = true;
    return result;
  }

  override async putWrites(
    ...args: Parameters<MemorySaver['putWrites']>
  ): ReturnType<MemorySaver['putWrites']> {
    const result = await super.putWrites(...args);
    this.noteThreadBucket(args[0]?.configurable?.thread_id);
    this.dirty = true;
    return result;
  }

  override async deleteThread(
    ...args: Parameters<MemorySaver['deleteThread']>
  ): ReturnType<MemorySaver['deleteThread']> {
    const result = await super.deleteThread(...args);
    const firstArg = args[0] as unknown;
    const threadId = typeof firstArg === 'string'
      ? firstArg
      : (firstArg as { configurable?: { thread_id?: unknown } } | undefined)?.configurable?.thread_id;
    if (typeof threadId === 'string' && threadId) {
      this.threadBuckets.delete(threadId);
    }
    this.dirty = true;
    return result;
  }

  // --- Persistence ---

  private noteThreadBucket(threadId: unknown, date = new Date()) {
    if (typeof threadId !== 'string' || !threadId) {
      return;
    }
    if (!this.threadBuckets.has(threadId)) {
      this.threadBuckets.set(threadId, formatDateBucket(date));
    }
  }

  private buildShardFilePath(bucket: string, threadId: string) {
    return join(
      this.shardRootDir,
      `${this.shardBaseName}.${bucket}.${encodeURIComponent(threadId)}${this.shardExt}`,
    );
  }

  private listShardFiles() {
    if (!existsSync(this.shardRootDir)) {
      return [];
    }
    const prefix = `${this.shardBaseName}.`;
    return readdirSync(this.shardRootDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(this.shardExt))
      .map((name) => join(this.shardRootDir, name));
  }

  private restoreThreadShard(data: ThreadShardData, fallbackDate: Date) {
    const bucket = data.bucket || formatDateBucket(fallbackDate);
    const threadId = data.threadId;
    if (!threadId) {
      return;
    }

    this.storage[threadId] ??= {};
    for (const [namespace, checkpoints] of Object.entries(data.storage ?? {})) {
      this.storage[threadId][namespace] ??= {};
      for (const [checkpointId, tuple] of Object.entries(checkpoints)) {
        this.storage[threadId][namespace][checkpointId] = [
          base64ToUint8(tuple[0]),
          base64ToUint8(tuple[1]),
          tuple[2],
        ];
      }
    }

    for (const [outerKey, writes] of Object.entries(data.writes ?? {})) {
      this.writes[outerKey] ??= {};
      for (const [innerKey, tuple] of Object.entries(writes)) {
        this.writes[outerKey][innerKey] = [
          tuple[0],
          tuple[1],
          base64ToUint8(tuple[2]),
        ];
      }
    }

    this.threadBuckets.set(threadId, bucket);
    this._loadedThreadCount += 1;
  }

  private load() {
    const shardFiles = this.listShardFiles();
    if (shardFiles.length > 0) {
      for (const file of shardFiles) {
        try {
          const raw = readFileSync(file, 'utf-8');
          const data = JSON.parse(raw) as ThreadShardData;
          this.restoreThreadShard(data, statSync(file).mtime);
          if (data.threadId) {
            this.knownShardFiles.set(data.threadId, file);
          }
        } catch {
          // ignore corrupt shard files
        }
      }
      return;
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as MemorySaverData;
      const legacyDate = statSync(this.filePath).mtime;
      const bucket = formatDateBucket(legacyDate);

      for (const [threadId, namespaces] of Object.entries(data.storage ?? {})) {
        const threadWrites: Record<string, Record<string, [string, string, string]>> = {};
        for (const [outerKey, writes] of Object.entries(data.writes ?? {})) {
          if (parseWriteThreadId(outerKey) === threadId) {
            threadWrites[outerKey] = writes;
          }
        }
        this.restoreThreadShard({
          threadId,
          bucket,
          storage: namespaces,
          writes: threadWrites,
        }, legacyDate);
      }
    } catch {
      // No file or corrupt — start fresh
    }
  }

  flush() {
    if (!this.dirty) return;
    try {
      mkdirSync(this.shardRootDir, { recursive: true });

      const threadIds = new Set<string>([
        ...Object.keys(this.storage),
        ...Array.from(this.threadBuckets.keys()),
      ]);

      for (const outerKey of Object.keys(this.writes)) {
        const threadId = parseWriteThreadId(outerKey);
        if (threadId) {
          threadIds.add(threadId);
          this.noteThreadBucket(threadId);
        }
      }

      const desiredFiles = new Map<string, string>();

      for (const threadId of threadIds) {
        const namespaces = this.storage[threadId];
        const threadWrites: Record<string, Record<string, [string, string, Uint8Array]>> = {};
        for (const [outerKey, writes] of Object.entries(this.writes)) {
          if (parseWriteThreadId(outerKey) === threadId) {
            threadWrites[outerKey] = writes;
          }
        }

        const hasStorage = namespaces && Object.keys(namespaces).length > 0;
        const hasWrites = Object.keys(threadWrites).length > 0;
        const previousFile = this.knownShardFiles.get(threadId);

        if (!hasStorage && !hasWrites) {
          if (previousFile && existsSync(previousFile)) {
            unlinkSync(previousFile);
          }
          this.knownShardFiles.delete(threadId);
          continue;
        }

        const bucket = this.threadBuckets.get(threadId) ?? formatDateBucket(new Date());
        this.threadBuckets.set(threadId, bucket);

        const file = this.buildShardFilePath(bucket, threadId);
        desiredFiles.set(threadId, file);

        const shard: ThreadShardData = {
          threadId,
          bucket,
          storage: {},
          writes: {},
        };

        if (hasStorage) {
          for (const [namespace, checkpoints] of Object.entries(namespaces)) {
            shard.storage[namespace] = {};
            for (const [checkpointId, tuple] of Object.entries(checkpoints)) {
              shard.storage[namespace][checkpointId] = [
                uint8ToBase64(tuple[0]),
                uint8ToBase64(tuple[1]),
                tuple[2],
              ];
            }
          }
        }

        for (const [outerKey, writes] of Object.entries(threadWrites)) {
          shard.writes[outerKey] = {};
          for (const [innerKey, tuple] of Object.entries(writes)) {
            shard.writes[outerKey][innerKey] = [
              tuple[0],
              tuple[1],
              uint8ToBase64(tuple[2]),
            ];
          }
        }

        writeFileSync(file, JSON.stringify(shard), 'utf-8');

        if (previousFile && previousFile !== file && existsSync(previousFile)) {
          unlinkSync(previousFile);
        }
        this.knownShardFiles.set(threadId, file);
      }

      if (existsSync(this.filePath) && this.listShardFiles().length > 0) {
        unlinkSync(this.filePath);
      }

      this.dirty = false;
    } catch (err) {
      console.warn(`[file-saver] flush failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private startAutoFlush() {
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    // Prevent timer from keeping the process alive
    this.flushTimer.unref();

    this.exitHandler = () => this.flush();
    process.on('exit', this.exitHandler);
    process.on('SIGINT', () => {
      this.flush();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      this.flush();
      process.exit(0);
    });
  }

  dispose() {
    this.flush();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.exitHandler) {
      process.removeListener('exit', this.exitHandler);
      this.exitHandler = null;
    }
  }
}
