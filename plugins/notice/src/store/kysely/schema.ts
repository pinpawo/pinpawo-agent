import type { NoticeLevel } from '../noticeStore';

/** The Notice table in the Studio database. */
export type NoticeDatabase = {
  notices: {
    notice_id: string;
    rule_id: string;
    level: NoticeLevel;
    title: string;
    source: string;
    event_type: string;
    /** JSON text; null when the event had no payload. */
    payload: string | null;
    occurred_at: string;
  };
};
