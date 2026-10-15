import { randomUUID } from 'node:crypto';
import type { Notice, NoticeLevel, NoticeStore } from './store/noticeStore';

export type { Notice, NoticeLevel } from './store/noticeStore';

const LEVELS = new Set<NoticeLevel>(['info', 'warning', 'error']);

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Notice ${label} must not be empty.`);
  return normalized;
}

/** Notice rules over a NoticeStore. Notifications are best effort after commit. */
export class NoticeService {
  private readonly listeners = new Set<(notice: Notice) => void>();

  constructor(readonly store: NoticeStore) {}

  subscribe(listener: (notice: Notice) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(input: Omit<Notice, 'noticeId' | 'occurredAt'> & { occurredAt?: string }): Promise<Notice> {
    if (!LEVELS.has(input.level)) throw new Error(`Notice level "${input.level}" is unsupported.`);
    const notice: Notice = {
      noticeId: randomUUID(),
      ruleId: nonEmpty(input.ruleId, 'ruleId'),
      level: input.level,
      title: nonEmpty(input.title, 'title'),
      source: nonEmpty(input.source, 'source'),
      eventType: nonEmpty(input.eventType, 'eventType'),
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    };
    await this.store.insertNotice(notice);
    for (const listener of this.listeners) {
      try {
        listener(notice);
      } catch (error) {
        console.error('[notice] committed notice listener failed:', error);
      }
    }
    return notice;
  }

  async snapshot(limit = 100): Promise<{ notices: Notice[] }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Notice limit must be from 1 to 1000.');
    }
    return { notices: await this.store.listNotices(limit) };
  }
}
