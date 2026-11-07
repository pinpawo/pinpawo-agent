import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';
import { createStudioWithPets } from '../../../tests/support/livePets';
import { createChannelPlugin } from './channelPlugin';

test('authenticated Channel HTTP rejects retired attachment input and still stores ordinary messages', async () => {
  const token = 'channel-message-retirement-fixture';
  const channel = createChannelPlugin();
  const http = createStudioHttpPlugin({ port: 0, authToken: token });
  const studio = await createStudioWithPets({
    studioId: 'channel-message-retirement', plugins: [channel, http], pets: [],
    storage: { kind: 'sqlite', path: ':memory:' },
  });
  const base = `http://127.0.0.1:${http.address()!.port}`;
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  try {
    const created = await call('/channels', { title: 'Ordinary messages', pets: [] });
    assert.equal(created.status, 201);
    const channelId = (created.body.channel as { channelId: string }).channelId;
    for (const artifacts of [[], [{ uri: 'https://example.test/old-reference', label: 'Old input' }]]) {
      const rejected = await call('/channels/messages', { channelId, body: 'Do not save this.', artifacts });
      assert.equal(rejected.status, 400);
    }
    const posted = await call('/channels/messages', { channelId, body: 'Keep the ordinary message.' });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.body, 'Keep the ordinary message.');
    assert.equal(Object.hasOwn(posted.body, 'artifacts'), false);
    const context = await call(`/channels/context?channelId=${encodeURIComponent(channelId)}`);
    assert.equal(context.status, 200);
    const messages = context.body.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.body, posted.body.body);
    assert.equal(Object.hasOwn(messages[0]!, 'artifacts'), false);
    const deliverables = [{ uri: 'artifact://workspace/session/report/report.pdf', title: 'Report' }];
    const delivered = await call('/channels/messages', { channelId, body: 'Use this report.', deliverables });
    assert.equal(delivered.status, 201);
    assert.deepEqual(delivered.body.deliverables, deliverables);
    const rejected = await call('/channels/messages', { channelId, body: 'Invalid declaration.', deliverables: [{ uri: 4 }] });
    assert.equal(rejected.status, 400);
    const reread = await call(`/channels/context?channelId=${encodeURIComponent(channelId)}`);
    assert.deepEqual((reread.body.messages as Array<Record<string, unknown>>).at(-1)?.deliverables, deliverables);
    assert.equal((reread.body.messages as unknown[]).length, 2);
  } finally { await studio.shutdown(); }
});
