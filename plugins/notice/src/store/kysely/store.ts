import type { Kysely, Selectable } from 'kysely';
import type { Notice, NoticeStore } from '../noticeStore';
import type { NoticeDatabase } from './schema';

function payloadText(payload: unknown): string | null {
  if (payload === undefined) return null;
  try {
    return JSON.stringify(payload) ?? 'null';
  } catch {
    return JSON.stringify({ unavailable: 'Notice payload was not serializable.' });
  }
}

function noticeRow(record: Selectable<NoticeDatabase['notices']>): Notice {
  return {
    noticeId: record.notice_id,
    ruleId: record.rule_id,
    level: record.level,
    title: record.title,
    source: record.source,
    eventType: record.event_type,
    ...(record.payload === null ? {} : { payload: JSON.parse(record.payload) as unknown }),
    occurredAt: record.occurred_at,
  };
}

/** The NoticeStore on the Studio database (SQLite or Postgres). */
export class KyselyNoticeStore implements NoticeStore {
  constructor(private readonly db: Kysely<NoticeDatabase>) {}

  async insertNotice(notice: Notice): Promise<void> {
    await this.db.insertInto('notices').values({
      notice_id: notice.noticeId,
      rule_id: notice.ruleId,
      level: notice.level,
      title: notice.title,
      source: notice.source,
      event_type: notice.eventType,
      payload: payloadText(notice.payload),
      occurred_at: notice.occurredAt,
    }).execute();
  }

  async listNotices(limit: number): Promise<Notice[]> {
    return (await this.db.selectFrom('notices').selectAll()
      .orderBy('occurred_at', 'desc').orderBy('notice_id', 'desc').limit(limit).execute()).map(noticeRow);
  }
}
