export type NoticeLevel = 'info' | 'warning' | 'error';

export type Notice = {
  noticeId: string;
  ruleId: string;
  level: NoticeLevel;
  title: string;
  source: string;
  eventType: string;
  payload?: unknown;
  occurredAt: string;
};

/**
 * Notice persistence. Data operations only; validation belongs to
 * NoticeService above it.
 */
export interface NoticeStore {
  insertNotice(notice: Notice): Promise<void>;
  /** Newest first. */
  listNotices(limit: number): Promise<Notice[]>;
}
