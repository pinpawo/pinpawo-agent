import { sql, type Generated, type Kysely, type Selectable } from 'kysely';
import type { StudioMigrations, StudioStorageDialect } from '@pinpawo/studio';
import type {
  ChannelMemberRow, ChannelMessageRow, ChannelRow, ChannelSessionRow, ChannelStore, MemberRef, Page, PageOf,
} from './channelStore';

/** The Channel Plugin's tables in the Studio database. */
export type ChannelDatabase = {
  channels: {
    seq: Generated<number>;
    channel_id: string;
    title: string;
    description: string | null;
    created_by_kind: MemberRef['kind'];
    created_by_id: string;
    created_at: string;
    updated_at: string;
  };
  channel_members: {
    channel_id: string;
    member_kind: MemberRef['kind'];
    member_id: string;
    joined_at: string;
    left_at: string | null;
  };
  channel_messages: {
    sequence: Generated<number>;
    message_id: string;
    channel_id: string;
    author_kind: MemberRef['kind'];
    author_id: string;
    occurred_at: string;
    external_ref: string | null;
    /** body, replyTo, mentions and artifacts, as JSON text. */
    data: string;
  };
  channel_sessions: {
    channel_id: string;
    pet_id: string;
    session_id: string;
    registered: number;
  };
};

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

type Record<T extends keyof ChannelDatabase> = Selectable<ChannelDatabase[T]>;

function channelRow(record: Record<'channels'>): ChannelRow {
  return {
    channelId: record.channel_id, title: record.title,
    ...(record.description === null ? {} : { description: record.description }),
    createdBy: { kind: record.created_by_kind, id: record.created_by_id },
    createdAt: record.created_at, updatedAt: record.updated_at,
  };
}
function memberRow(record: Record<'channel_members'>): ChannelMemberRow {
  return {
    channelId: record.channel_id, kind: record.member_kind, id: record.member_id, joinedAt: record.joined_at,
    ...(record.left_at === null ? {} : { leftAt: record.left_at }),
  };
}
function messageRow(record: Record<'channel_messages'>): ChannelMessageRow {
  const data = JSON.parse(record.data) as Pick<ChannelMessageRow, 'body' | 'replyTo' | 'mentions' | 'artifacts'>;
  return {
    sequence: record.sequence, messageId: record.message_id, channelId: record.channel_id,
    author: { kind: record.author_kind, id: record.author_id }, occurredAt: record.occurred_at,
    ...(record.external_ref === null ? {} : { externalRef: record.external_ref }),
    ...data,
  };
}
function sessionRow(record: Record<'channel_sessions'>): ChannelSessionRow {
  return { channelId: record.channel_id, petId: record.pet_id, sessionId: record.session_id, registered: !!record.registered };
}
function paged<T, R>(records: T[], { after, limit }: Page, cursor: (record: T) => number, row: (record: T) => R): PageOf<R> {
  const items = records.slice(0, limit);
  return { items: items.map(row), nextAfter: items.length ? cursor(items.at(-1)!) : after, hasMore: records.length > limit };
}

/** The ChannelStore on the Studio database (SQLite or Postgres). */
export class KyselyChannelStore implements ChannelStore {
  constructor(private readonly db: Kysely<ChannelDatabase>) {}

  transaction<T>(work: (store: ChannelStore) => Promise<T>): Promise<T> {
    if (this.db.isTransaction) return work(this);
    return this.db.transaction().execute(trx => work(new KyselyChannelStore(trx)));
  }

  async createChannel(row: ChannelRow): Promise<void> {
    await this.db.insertInto('channels').values({
      channel_id: row.channelId, title: row.title, description: row.description ?? null,
      created_by_kind: row.createdBy.kind, created_by_id: row.createdBy.id, created_at: row.createdAt, updated_at: row.updatedAt,
    }).execute();
  }

  async updateChannel(channelId: string, patch: { title?: string; description?: string | null; updatedAt: string }): Promise<void> {
    const result = await this.db.updateTable('channels').set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      updated_at: patch.updatedAt,
    }).where('channel_id', '=', channelId).executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) throw new Error(`Unknown Channel "${channelId}".`);
  }

  async getChannel(channelId: string): Promise<ChannelRow | undefined> {
    const record = await this.db.selectFrom('channels').selectAll().where('channel_id', '=', channelId).executeTakeFirst();
    return record ? channelRow(record) : undefined;
  }

  async listChannels(filter: { member?: MemberRef }, page: Page): Promise<PageOf<ChannelRow>> {
    let query = this.db.selectFrom('channels').selectAll('channels')
      .where('channels.seq', '>', page.after).orderBy('channels.seq').limit(page.limit + 1);
    if (filter.member) {
      const { kind, id } = filter.member;
      query = query.innerJoin('channel_members', 'channel_members.channel_id', 'channels.channel_id')
        .where('channel_members.member_kind', '=', kind).where('channel_members.member_id', '=', id)
        .where('channel_members.left_at', 'is', null);
    }
    return paged(await query.execute(), page, record => record.seq, channelRow);
  }

  async listMembers(channelId: string): Promise<ChannelMemberRow[]> {
    const records = await this.db.selectFrom('channel_members').selectAll().where('channel_id', '=', channelId)
      .orderBy('joined_at').orderBy('member_kind').orderBy('member_id').execute();
    return records.map(memberRow);
  }

  async upsertMember(row: ChannelMemberRow): Promise<void> {
    await this.db.insertInto('channel_members').values({
      channel_id: row.channelId, member_kind: row.kind, member_id: row.id, joined_at: row.joinedAt, left_at: row.leftAt ?? null,
    }).onConflict(conflict => conflict.columns(['channel_id', 'member_kind', 'member_id']).doUpdateSet({
      joined_at: eb => eb.ref('excluded.joined_at'), left_at: eb => eb.ref('excluded.left_at'),
    })).execute();
  }

  async appendMessage(row: Omit<ChannelMessageRow, 'sequence'>): Promise<ChannelMessageRow> {
    const { body, replyTo, mentions, artifacts } = row;
    const inserted = await this.db.insertInto('channel_messages').values({
      message_id: row.messageId, channel_id: row.channelId, author_kind: row.author.kind, author_id: row.author.id,
      occurred_at: row.occurredAt, external_ref: row.externalRef ?? null,
      data: JSON.stringify({ body, ...(replyTo ? { replyTo } : {}), mentions, artifacts }),
    }).onConflict(conflict => conflict.columns(['author_kind', 'author_id', 'external_ref']).doNothing())
      .returning('sequence').executeTakeFirst();
    if (inserted) return { ...row, sequence: inserted.sequence };
    // Only an external_ref the author already recorded can conflict.
    const existing = await this.db.selectFrom('channel_messages').selectAll()
      .where('author_kind', '=', row.author.kind).where('author_id', '=', row.author.id)
      .where('external_ref', '=', row.externalRef!).executeTakeFirstOrThrow();
    return messageRow(existing);
  }

  async getMessage(channelId: string, messageId: string): Promise<ChannelMessageRow | undefined> {
    const record = await this.db.selectFrom('channel_messages').selectAll()
      .where('channel_id', '=', channelId).where('message_id', '=', messageId).executeTakeFirst();
    return record ? messageRow(record) : undefined;
  }

  async readMessages(channelId: string, page: Page): Promise<PageOf<ChannelMessageRow>> {
    const records = await this.db.selectFrom('channel_messages').selectAll()
      .where('channel_id', '=', channelId).where('sequence', '>', page.after)
      .orderBy('sequence').limit(page.limit + 1).execute();
    return paged(records, page, record => record.sequence, messageRow);
  }

  async getSession(channelId: string, petId: string): Promise<ChannelSessionRow | undefined> {
    const record = await this.db.selectFrom('channel_sessions').selectAll()
      .where('channel_id', '=', channelId).where('pet_id', '=', petId).executeTakeFirst();
    return record ? sessionRow(record) : undefined;
  }

  async reserveSession(row: ChannelSessionRow): Promise<ChannelSessionRow> {
    await this.db.insertInto('channel_sessions').values({
      channel_id: row.channelId, pet_id: row.petId, session_id: row.sessionId, registered: row.registered ? 1 : 0,
    }).onConflict(conflict => conflict.columns(['channel_id', 'pet_id']).doNothing()).execute();
    return (await this.getSession(row.channelId, row.petId))!;
  }

  async confirmSession(row: ChannelSessionRow): Promise<void> {
    const result = await this.db.updateTable('channel_sessions').set({ registered: 1 })
      .where('channel_id', '=', row.channelId).where('pet_id', '=', row.petId).where('session_id', '=', row.sessionId)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) throw new Error('Channel session binding changed.');
  }

  async listSessions(channelId: string): Promise<ChannelSessionRow[]> {
    const records = await this.db.selectFrom('channel_sessions').selectAll().where('channel_id', '=', channelId).orderBy('pet_id').execute();
    return records.map(sessionRow);
  }
}
