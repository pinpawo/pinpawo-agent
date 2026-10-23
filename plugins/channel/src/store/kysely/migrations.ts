import { sql, type Kysely } from 'kysely';
import type { StudioMigrations, StudioStorageDialect } from '@pinpawo/studio-core';

/** The Channel schema. Data from the earlier Channel model is not carried over. */
export function channelMigrations(dialect: StudioStorageDialect): StudioMigrations {
  // The one dialect difference: how an increasing integer key is declared.
  const counter = dialect === 'postgres' ? 'serial' : 'integer';
  const kindCheck = (column: string) => sql`${sql.ref(column)} in ('human', 'pet')`;
  return {
    '0001_channels': {
      async up(db: Kysely<unknown>) {
        await db.schema.createTable('channels')
          .addColumn('seq', counter, column => (dialect === 'postgres' ? column.primaryKey() : column.primaryKey().autoIncrement()))
          .addColumn('channel_id', 'text', column => column.notNull().unique())
          .addColumn('title', 'text', column => column.notNull())
          .addColumn('description', 'text')
          .addColumn('created_by_kind', 'text', column => column.notNull().check(kindCheck('created_by_kind')))
          .addColumn('created_by_id', 'text', column => column.notNull())
          .addColumn('created_at', 'text', column => column.notNull())
          .addColumn('updated_at', 'text', column => column.notNull())
          .execute();
        await db.schema.createTable('channel_members')
          .addColumn('channel_id', 'text', column => column.notNull().references('channels.channel_id'))
          .addColumn('member_kind', 'text', column => column.notNull().check(kindCheck('member_kind')))
          .addColumn('member_id', 'text', column => column.notNull())
          .addColumn('joined_at', 'text', column => column.notNull())
          .addColumn('left_at', 'text')
          .addPrimaryKeyConstraint('channel_members_pk', ['channel_id', 'member_kind', 'member_id'])
          .execute();
        await db.schema.createIndex('channel_members_by_member').on('channel_members')
          .columns(['member_kind', 'member_id']).where(sql.ref('left_at'), 'is', null).execute();
        await db.schema.createTable('channel_messages')
          .addColumn('sequence', counter, column => (dialect === 'postgres' ? column.primaryKey() : column.primaryKey().autoIncrement()))
          .addColumn('message_id', 'text', column => column.notNull().unique())
          .addColumn('channel_id', 'text', column => column.notNull().references('channels.channel_id'))
          .addColumn('author_kind', 'text', column => column.notNull().check(kindCheck('author_kind')))
          .addColumn('author_id', 'text', column => column.notNull())
          .addColumn('occurred_at', 'text', column => column.notNull())
          .addColumn('external_ref', 'text')
          .addColumn('data', 'text', column => column.notNull())
          .addUniqueConstraint('channel_messages_external_ref', ['author_kind', 'author_id', 'external_ref'])
          .execute();
        await db.schema.createIndex('channel_message_history').on('channel_messages').columns(['channel_id', 'sequence']).execute();
        await db.schema.createTable('channel_sessions')
          .addColumn('channel_id', 'text', column => column.notNull().references('channels.channel_id'))
          .addColumn('pet_id', 'text', column => column.notNull())
          .addColumn('session_id', 'text', column => column.notNull())
          .addColumn('registered', 'integer', column => column.notNull().defaultTo(0))
          .addPrimaryKeyConstraint('channel_sessions_pk', ['channel_id', 'pet_id'])
          .addUniqueConstraint('channel_sessions_session', ['pet_id', 'session_id'])
          .execute();
      },
    },
  };
}
