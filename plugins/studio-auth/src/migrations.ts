import type { Kysely } from 'kysely';
import { getAuthTables } from 'better-auth/db';
import type { StudioMigrations, StudioStorageDialect } from '@pinpawo/studio-core';

import { studioAuthOptions, type StudioAuthConfig } from './authOptions';

/**
 * The column types this Plugin asks Kysely for. Kysely 0.29 does not re-export
 * `DataTypeExpression` from its package root, and every entry here is a plain
 * SQL type name, so the literal union is both narrower and stable.
 */
type ColumnType = 'text' | 'integer' | 'boolean' | 'timestamptz' | 'jsonb';

type ColumnAttribute = {
  type: string;
  required?: boolean;
  unique?: boolean;
  fieldName?: string;
  defaultValue?: unknown;
};

const COLUMN_TYPES: Record<StudioStorageDialect, Record<string, ColumnType>> = {
  sqlite: { string: 'text', number: 'integer', boolean: 'integer', date: 'text', json: 'text' },
  postgres: { string: 'text', number: 'integer', boolean: 'boolean', date: 'timestamptz', json: 'jsonb' },
};

function readDefault(attribute: ColumnAttribute, dialect: StudioStorageDialect): unknown {
  const value = attribute.defaultValue;
  if (value === undefined) return undefined;
  const resolved = typeof value === 'function' ? (value as () => unknown)() : value;
  if (typeof resolved === 'boolean' && dialect === 'sqlite') return resolved ? 1 : 0;
  if (typeof resolved === 'number' || typeof resolved === 'string') return resolved;
  return undefined;
}

/**
 * Better Auth's tables, generated from the same options the runtime uses, so a
 * library upgrade that adds a column fails loudly at startup (Better Auth's own
 * schema check) instead of silently at query time.
 */
export function studioAuthMigrations(
  dialect: StudioStorageDialect,
  config: StudioAuthConfig,
): StudioMigrations {
  return {
    '0001_better_auth': {
      async up(db: Kysely<unknown>) {
        const tables = getAuthTables(studioAuthOptions(config));
        for (const table of Object.values(tables)) {
          let builder = db.schema
            .createTable(table.modelName)
            // Better Auth generates ids itself; every table carries the same key.
            .addColumn('id', 'text', (column) => column.primaryKey());
          for (const [field, raw] of Object.entries(table.fields)) {
            const attribute = raw as ColumnAttribute;
            const type = COLUMN_TYPES[dialect][attribute.type ?? 'string'] ?? 'text';
            const fallback = readDefault(attribute, dialect);
            builder = builder.addColumn(attribute.fieldName ?? field, type, (column) => {
              let next = column;
              if (attribute.required) next = next.notNull();
              if (attribute.unique) next = next.unique();
              if (fallback !== undefined) next = next.defaultTo(fallback);
              return next;
            });
          }
          await builder.execute();
        }
        // Login looks users up by username on every attempt.
        await db.schema
          .createIndex('studio_auth_user_by_username')
          .on('studio_auth_user' as never)
          .column('username' as never)
          .execute();
        await db.schema
          .createIndex('studio_auth_session_by_user')
          .on('studio_auth_session' as never)
          .column('user_id' as never)
          .execute();
      },
    },
    '0002_auth_audit': {
      async up(db: Kysely<unknown>) {
        await db.schema
          .createTable('studio_auth_audit')
          .addColumn('seq', dialect === 'postgres' ? 'serial' : 'integer', (column) => (
            dialect === 'postgres' ? column.primaryKey() : column.primaryKey().autoIncrement()
          ))
          .addColumn('occurred_at', 'text', (column) => column.notNull())
          .addColumn('action', 'text', (column) => column.notNull())
          .addColumn('result', 'text', (column) => column.notNull())
          .addColumn('user_id', 'text')
          .addColumn('username', 'text')
          .addColumn('client_id', 'text')
          .addColumn('reason', 'text')
          .addColumn('remote_addr', 'text')
          .addColumn('user_agent', 'text')
          .execute();
        await db.schema
          .createIndex('studio_auth_audit_by_time')
          .on('studio_auth_audit')
          .column('occurred_at')
          .execute();
      },
    },
    /**
     * Every authenticated request looks a session up by token hash. That column
     * holds the SHA-256 of the bearer token (see StudioAuthRepository): Better
     * Auth's own session API is not used, so no plaintext token reaches this table.
     */
    '0003_auth_session_token': {
      async up(db: Kysely<unknown>) {
        await db.schema
          .createIndex('studio_auth_session_by_token')
          .on('studio_auth_session' as never)
          .column('token' as never)
          .execute();
      },
    },
    /**
     * Credential versioning: a session records the version it was minted under
     * and a password change bumps the user's version. A login that verified the
     * old password therefore cannot create a session after the change landed,
     * and any session that slipped through fails verification (see
     * StudioAuthRepository).
     */
    '0004_auth_credential_version': {
      async up(db: Kysely<unknown>) {
        await db.schema
          .alterTable('studio_auth_user')
          .addColumn('credential_version', 'integer', (column) => column.notNull().defaultTo(0))
          .execute();
        await db.schema
          .alterTable('studio_auth_session')
          .addColumn('credential_version', 'integer', (column) => column.notNull().defaultTo(0))
          .execute();
      },
    },
  };
}

export const STUDIO_AUTH_AUDIT_TABLE = 'studio_auth_audit';

export const studioAuthIndexes = {
  userByUsername: 'studio_auth_user_by_username',
  sessionByUser: 'studio_auth_session_by_user',
  sessionByToken: 'studio_auth_session_by_token',
  auditByTime: 'studio_auth_audit_by_time',
} as const;

