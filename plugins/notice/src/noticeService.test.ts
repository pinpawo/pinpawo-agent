import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStudioStorage, type StudioStorageConfig } from '@pinpawo/studio-core';
import { createPglitePool } from '../../../tests/support/pglitePool';
import { NoticeService } from './noticeService';
import { KyselyNoticeStore, noticeMigrations, type NoticeDatabase } from './store/kysely';

const backends: Array<[string, () => StudioStorageConfig]> = [
  ['sqlite', () => ({ kind: 'sqlite', path: ':memory:' })],
  ['postgres', () => ({ kind: 'postgres', pool: createPglitePool() })],
];

for (const [backend, config] of backends) {
  test(`${backend}: notices are stored with their payload and listed newest first`, async () => {
    const storage = createStudioStorage(config());
    try {
      const service = new NoticeService(new KyselyNoticeStore(await storage.open<NoticeDatabase>('notice', noticeMigrations())));
      const seen: string[] = [];
      service.subscribe(({ ruleId }) => seen.push(ruleId));
      const base = { level: 'warning' as const, title: 'Queue', source: 'scheduler', eventType: 'dispatch.queues_attention_required' };
      await service.create({ ...base, ruleId: 'older', occurredAt: '2026-09-01T00:00:00.000Z' });
      await service.create({ ...base, ruleId: 'newer', payload: { queues: [{ petId: 'worker' }], empty: null }, occurredAt: '2026-09-02T00:00:00.000Z' });
      await service.create({ ...base, ruleId: 'null-payload', payload: null, occurredAt: '2026-08-01T00:00:00.000Z' });
      await assert.rejects(service.create({ ...base, ruleId: ' ' }), /ruleId must not be empty/);
      await assert.rejects(service.create({ ...base, ruleId: 'x', level: 'fatal' as never }), /unsupported/);
      await assert.rejects(service.snapshot(0), /from 1 to 1000/);

      const { notices } = await service.snapshot();
      assert.deepEqual(notices.map(({ ruleId }) => ruleId), ['newer', 'older', 'null-payload']);
      assert.deepEqual(notices[0]?.payload, { queues: [{ petId: 'worker' }], empty: null });
      assert.equal('payload' in notices[1]!, false);
      assert.equal(notices[2]?.payload, null);
      assert.deepEqual((await service.snapshot(1)).notices.map(({ ruleId }) => ruleId), ['newer']);
      assert.deepEqual(seen, ['older', 'newer', 'null-payload']);
    } finally { await storage.close(); }
  });
}
