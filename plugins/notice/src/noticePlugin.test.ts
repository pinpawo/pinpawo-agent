import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStudio, type StudioPetBinding } from '@pinpawo/studio';
import { createNoticePlugin } from './noticePlugin';

const worker: StudioPetBinding = {
  registration: { petId: 'worker', name: 'Worker', role: null, serviceSummary: null },
  dispatch: {
    getQueueSnapshot: () => ({
      state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0,
    }),
    onQueueChange: () => () => undefined,
    onDispatchLifecycle: () => () => undefined,
    dispatch: async () => undefined,
  },
};

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for notice');
}

test('Notice persists configured Studio event facts without participating in dispatch', async (t) => {
  const notice = createNoticePlugin({
    rules: [{
      noticeId: 'blocked-queue',
      title: 'Dispatch queue needs attention',
      level: 'warning',
      source: {
        kind: 'studio_event',
        eventSource: 'scheduler',
        type: 'dispatch.queues_attention_required',
      },
    }],
    httpRoute: false,
  });
  const studio = await createStudio({
    studioId: 'notice-test',
    entryPetId: 'worker',
    pets: [worker],
    plugins: [notice],
  });
  t.after(() => studio.shutdown());

  studio.notify({
    source: 'scheduler',
    type: 'dispatch.queues_attention_required',
    occurredAt: '2026-09-02T00:00:00.000Z',
    payload: { queues: [{ petId: 'worker', state: 'blocked' }] },
  });

  await waitFor(async () => (await notice.service.snapshot()).notices.length === 1);
  assert.deepEqual(await notice.service.snapshot(), {
    notices: [{
      noticeId: (await notice.service.snapshot()).notices[0]!.noticeId,
      ruleId: 'blocked-queue',
      level: 'warning',
      title: 'Dispatch queue needs attention',
      source: 'scheduler',
      eventType: 'dispatch.queues_attention_required',
      payload: { queues: [{ petId: 'worker', state: 'blocked' }] },
      occurredAt: '2026-09-02T00:00:00.000Z',
    }],
  });
});
