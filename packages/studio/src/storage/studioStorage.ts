import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  Kysely,
  PostgresDialect,
  SqliteDialect,
  type Dialect,
  type PostgresPool,
  type SqliteDatabase,
} from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';

export type StudioStorageDialect = 'sqlite' | 'postgres';

/**
 * Where a Studio keeps Plugin data. One database per Studio; every Plugin
 * owns its own tables and migration history in it.
 */
export type StudioStorageConfig =
  /** A file path, or `:memory:` for a throwaway database. */
  | { kind: 'sqlite'; path: string }
  | { kind: 'postgres'; url: string }
  /** An already-configured pool, for embedding and tests. Studio ends it on close. */
  | { kind: 'postgres'; pool: PostgresPool | (() => Promise<PostgresPool>) };

/** One Plugin's migrations, applied in name order. Each runs once. */
export type StudioMigrations = Record<string, Migration>;

export type StudioStorage = {
  readonly dialect: StudioStorageDialect;
  /**
   * Apply the owner's pending migrations, then return the shared database.
   * The owner's history lives in `<owner>_migrations`, apart from other owners.
   */
  open: <DB>(owner: string, migrations: StudioMigrations) => Promise<Kysely<DB>>;
  close: () => Promise<void>;
};

/** What a Plugin sees: the same database, with its own migration history. */
export type StudioPluginStorage = {
  readonly dialect: StudioStorageDialect;
  open: <DB>(migrations: StudioMigrations) => Promise<Kysely<DB>>;
};

/** node:sqlite behind the statement interface Kysely's SQLite dialect expects. */
function openSqlite(file: string): SqliteDatabase {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: 5_000, enableForeignKeyConstraints: true });
  try {
    if (file !== ':memory:') chmodSync(file, 0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
  } catch (error) { db.close(); throw error; }
  return {
    close: () => db.close(),
    prepare(sql) {
      const statement = db.prepare(sql);
      const values = (parameters: ReadonlyArray<unknown>) => parameters as SQLInputValue[];
      // node:sqlite rows have a null prototype; give Plugins ordinary objects, as pg does.
      const plain = (row: unknown) => ({ ...(row as object) });
      return {
        reader: statement.columns().length > 0,
        all: parameters => statement.all(...values(parameters)).map(plain),
        run: parameters => statement.run(...values(parameters)),
        *iterate(parameters) { for (const row of statement.iterate(...values(parameters))) yield plain(row); },
      };
    },
  };
}

function dialectFor(config: StudioStorageConfig): Dialect {
  if (config.kind === 'sqlite') {
    // Opened on first query, so a Studio whose Plugins store nothing creates no file.
    return new SqliteDialect({ database: async () => openSqlite(config.path) });
  }
  if ('pool' in config) return new PostgresDialect({ pool: config.pool });
  return new PostgresDialect({
    pool: async () => {
      const { default: pg } = await import('pg');
      return new pg.Pool({ connectionString: config.url });
    },
  });
}

function migrationTable(owner: string): string {
  const name = owner.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!name) throw new Error(`Storage owner "${owner}" has no usable name.`);
  return `${name}_migrations`;
}

export function createStudioStorage(config: StudioStorageConfig): StudioStorage {
  const db = new Kysely<unknown>({ dialect: dialectFor(config) });
  const pending = new Set<Promise<void>>();
  let closed = false;

  async function migrate(owner: string, migrations: StudioMigrations): Promise<void> {
    const table = migrationTable(owner);
    const { error } = await new Migrator({
      db,
      provider: { getMigrations: async () => migrations },
      migrationTableName: table,
      migrationLockTableName: `${table}_lock`,
    }).migrateToLatest();
    if (error) {
      throw new Error(`Storage migrations for "${owner}" failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  return {
    dialect: config.kind,
    async open<DB>(owner: string, migrations: StudioMigrations) {
      if (closed) throw new Error('Studio storage is closed.');
      const migrating = migrate(owner, migrations);
      pending.add(migrating);
      try { await migrating; }
      finally { pending.delete(migrating); }
      return db as unknown as Kysely<DB>;
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(pending);
      await db.destroy();
    },
  };
}
