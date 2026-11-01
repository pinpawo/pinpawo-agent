import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';
import { createStudioWithPets } from '../../../tests/support/livePets';
import { createChannelPlugin } from './channelPlugin';

test('only Studio authority sets Channel prompts through authenticated HTTP', async () => {
  const studioToken = 'channel-prompt-http-test';
  const channel = createChannelPlugin();
  const http = createStudioHttpPlugin({ port: 0, authToken: studioToken });
  const studio = await createStudioWithPets({
    studioId: 'channel-prompt-http', plugins: [channel, http],
    pets: [{ registration: { petId: 'one', name: 'One' }, dispatch: {
      getQueueSnapshot: () => ({ state: 'open' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
      onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {}, dispatch: async () => {},
    } }],
  });
  const base = `http://127.0.0.1:${http.address()!.port}`;
  const call = async (token: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const alice = await call(studioToken, '/clients', { clientId: 'alice', label: 'Alice' });
    const bob = await call(studioToken, '/clients', { clientId: 'bob', label: 'Bob' });
    assert.equal(alice.status, 201);
    assert.equal(bob.status, 201);
    assert.equal((await call(alice.body.key, '/channels', { title: 'Injected', prompt: 'Forged', pets: ['one'] })).status, 403);
    const created = await call(alice.body.key, '/channels', { title: 'Shared', pets: ['one'] });
    assert.equal(created.status, 201);
    const channelId = created.body.channel.channelId as string;
    assert.equal((await call(alice.body.key, '/channels/members', { channelId, kind: 'human', id: 'bob' })).status, 201);
    for (const key of [alice.body.key, bob.body.key]) {
      assert.equal((await call(key, '/channels/update', { channelId, prompt: 'Forged' })).status, 403);
      assert.equal((await call(key, '/channels/update', { channelId, prompt: null })).status, 403);
    }
    assert.equal((await call(bob.body.key, '/channels/update', { channelId, title: 'Renamed' })).status, 200);
    const edited = await call(studioToken, '/channels/update', { channelId, prompt: 'Studio convention' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.prompt, 'Studio convention');
    const context = await call(bob.body.key, `/channels/context?channelId=${channelId}`);
    assert.equal(context.body.channel.prompt, 'Studio convention');
    assert.equal((await call(studioToken, '/channels/update', { channelId, prompt: null })).status, 200);
    assert.equal((await call(studioToken, '/channels', { title: 'Studio channel', prompt: 'Initial', pets: ['one'] })).status, 201);
  } finally { await studio.shutdown(); }
});
