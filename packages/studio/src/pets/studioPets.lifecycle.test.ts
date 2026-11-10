import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioStorage } from '../storage/studioStorage';
import { studioCoreMigrations } from '../storage/coreMigrations';
import { KyselyPetStore, type PetDatabase } from './store/kysely';
import { StudioPetCredentialVault } from './petCredentials';
import { StudioPetRegistry } from './studioPets';
import type { StudioPetRuntime } from '../types';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(t: import('node:test').TestContext, close: () => Promise<void> = async () => {},
  hooks: Pick<ConstructorParameters<typeof StudioPetRegistry>[0], 'prepareInstance' | 'deactivateInstance'> = {}) {
  const storage = createStudioStorage({ kind: 'sqlite', path: ':memory:' });
  const db = await storage.open<PetDatabase>('studio', studioCoreMigrations);
  const store = new KyselyPetStore(db);
  const credentials = new StudioPetCredentialVault({ store: async () => store, key: new Uint8Array(32).fill(7) });
  let closes = 0;
  const assembled: string[] = [];
  const events: string[] = [];
  const registry = new StudioPetRegistry({ studioId: 'lifecycle', store: async () => store, credentials,
    definitions: [{ definitionId: 'worker', name: 'Worker' }], requireChannel: async id => { assert.equal(id, 'one'); }, ...hooks,
    assemble: async ({ petId }): Promise<StudioPetRuntime> => {
      assembled.push(petId);
      return { close: async () => { closes++; await close(); }, dispatch: {
        getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
        onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {}, dispatch: async () => {},
      } };
    }, onLive: () => {}, onClosed: () => {}, onChange: type => { events.push(type); },
  });
  t.after(async () => { await registry.close(); await storage.close(); });
  await registry.create({ petId: 'pet', definitionId: 'worker', name: 'Pet', channelId: 'one' });
  return { registry, store, credentials, events, assembled, closes: () => closes };
}

for (const action of ['close', 'remove'] as const) {
  const marker = action === 'close' ? 'closedAt' : 'removedAt';
  const ending = (registry: StudioPetRegistry, confirmStop = false) => action === 'close'
    ? registry.closeInstance('pet', { confirmStop }) : registry.removeInstance('pet', { confirmStop });

  test(`${action} requires stop consent, dedupes, and commits only after runtime settlement`, async t => {
    const stopped = deferred();
    t.after(() => stopped.resolve());
    const { registry, store, events, closes, credentials } = await setup(t, () => stopped.promise);
    await credentials.set({ petId: 'pet', envName: 'TOKEN', value: 'test-value' });
    await assert.rejects(ending(registry), (e: { code?: string }) => e.code === 'confirmation_required');
    assert.ok(registry.getLive('pet'));
    const first = ending(registry, true), repeated = ending(registry, true);
    await tick();
    assert.equal(closes(), 1);
    assert.equal(registry.getLive('pet'), undefined);
    assert.equal((await store.getPet('pet'))?.[marker], undefined);
    assert.equal(events.includes(`pet.${action === 'close' ? 'closed' : 'removed'}`), false);
    await assert.rejects(registry.reopenInstance('pet'), (e: { code?: string }) => e.code === 'busy');
    stopped.resolve();
    const [ended, again] = await Promise.all([first, repeated]);
    assert.ok(ended[marker]);
    assert.deepEqual(again, ended);
    assert.equal((await store.getPet('pet'))?.[marker], ended[marker]);
    assert.deepEqual(await credentials.source.environment('pet'), { TOKEN: 'test-value' });
    await assert.rejects(registry.create({ petId: 'pet', definitionId: 'worker', name: 'Other', channelId: 'one' }), /already exists/);
    assert.equal((await ending(registry))[marker], ended[marker]);
    assert.equal(closes(), 1);
    assert.equal(events.filter(type => type === `pet.${action === 'close' ? 'closed' : 'removed'}`).length, 1);
    if (action === 'remove') await assert.rejects(registry.reopenInstance('pet'), /permanently removed/);
    else {
      const reopened = await registry.reopenInstance('pet');
      assert.equal(reopened.closedAt, undefined);
      assert.equal(reopened.removedAt, undefined);
      assert.equal(reopened.petId, ended.petId);
      assert.equal(reopened.channelId, ended.channelId);
      assert.ok(registry.getLive('pet'));
    }
  });

  test(`${action} stop failure retains the instance and refuses new work without a final marker`, async t => {
    const { registry, store, events } = await setup(t, async () => { throw new Error('stop failed'); });
    await assert.rejects(ending(registry, true), /stop failed/);
    assert.equal((await store.getPet('pet'))?.[marker], undefined);
    assert.equal(registry.getLive('pet'), undefined);
    assert.equal(events.includes(`pet.${action === 'close' ? 'closed' : 'removed'}`), false);
  });

  test(`uncertain ${action} write never claims success and explicit retry reads persisted state`, async t => {
    const { registry, store, events, closes } = await setup(t);
    const method = action === 'close' ? 'closePet' : 'removePet';
    const persist = store[method].bind(store);
    store[method] = async (...args) => { await persist(...args); throw new Error('acknowledgment lost'); };
    await assert.rejects(ending(registry, true), /acknowledgment lost/);
    assert.equal(events.includes(`pet.${action === 'close' ? 'closed' : 'removed'}`), false);
    assert.equal(registry.getLive('pet'), undefined);
    assert.ok((await ending(registry))[marker]);
    assert.equal(closes(), 1);
  });
}

async function failedReopen(t: import('node:test').TestContext) {
  let failStop = false;
  t.after(() => { failStop = false; });
  const fixture = await setup(t, async () => { if (failStop) throw new Error('stop unknown'); });
  await fixture.registry.closeInstance('pet', { confirmStop: true });
  const reopen = fixture.store.reopenPet.bind(fixture.store);
  fixture.store.reopenPet = async () => { throw new Error('reopen write failed'); };
  failStop = true;
  await assert.rejects(fixture.registry.reopenInstance('pet'), /stop unknown/);
  assert.equal(fixture.assembled.length, 2);
  return { ...fixture, settle: () => { failStop = false; fixture.store.reopenPet = reopen; } };
}

test('Reopen never overwrites a retained runtime whose failed cleanup has not stopped', async t => {
  const { registry, assembled, settle } = await failedReopen(t);
  await assert.rejects(registry.reopenInstance('pet'), (error: { code?: string }) => error.code === 'busy');
  assert.equal(assembled.length, 2, 'no second replacement runtime is assembled');
  assert.equal(registry.getLive('pet'), undefined);
  settle();
  await registry.closeInstance('pet', { confirmStop: true });
  await registry.reopenInstance('pet');
  assert.equal(assembled.length, 3, 'a new runtime is only possible after prior teardown settles');
});

test('an old closed marker cannot report Close success while a failed-Reopen runtime remains unsettled', async t => {
  const { registry, closes } = await failedReopen(t);
  await assert.rejects(registry.closeInstance('pet'), (error: { code?: string }) => error.code === 'confirmation_required');
  await assert.rejects(registry.closeInstance('pet', { confirmStop: true }), /stop unknown/);
  assert.equal(closes(), 3, 'confirmed Close retries the retained runtime teardown rather than trusting closedAt');
});


test('Channel preparation failure never assembles or exposes the new runtime and retains its closed identity', async t => {
  let fail = false;
  const { registry, assembled, store } = await setup(t, async () => {}, {
    prepareInstance: async () => { if (fail) throw new Error('baseline unavailable'); },
  });
  fail = true;
  await assert.rejects(registry.create({ petId: 'new', name: 'New', definitionId: 'worker', channelId: 'one' }), /baseline unavailable/);
  assert.deepEqual(assembled, ['pet']);
  assert.equal(registry.getLive('new'), undefined);
  assert.ok((await store.getPet('new'))?.closedAt);
  await assert.rejects(registry.create({ petId: 'new', name: 'New', definitionId: 'worker', channelId: 'one' }), /already exists/);
});

for (const action of ['close', 'remove'] as const) {
  const marker = action === 'close' ? 'closedAt' : 'removedAt';
  const ending = (registry: StudioPetRegistry) => action === 'close'
    ? registry.closeInstance('pet', { confirmStop: true }) : registry.removeInstance('pet', { confirmStop: true });

  test(`${action} starts Host stop without waiting for the Channel fence, and waits for both settlements`, async t => {
    const fence = deferred(), host = deferred();
    t.after(() => { fence.resolve(); host.resolve(); });
    const order: string[] = [];
    const { registry, store, events, closes } = await setup(t, async () => { order.push('host'); await host.promise; }, {
      deactivateInstance: () => { order.push('cancel'); return fence.promise; },
    });
    let complete = false;
    const pending = ending(registry).then(() => { complete = true; });
    await tick();
    assert.deepEqual(order, ['cancel', 'host']);
    assert.equal(closes(), 1);
    assert.equal(registry.getLive('pet'), undefined);
    assert.equal((await store.getPet('pet'))?.[marker], undefined);
    host.resolve();
    await tick();
    assert.equal(complete, false, 'Host stop alone cannot finalize while the Channel fence is pending');
    assert.equal(events.includes(action === 'close' ? 'pet.closed' : 'pet.removed'), false);
    fence.resolve();
    await pending;
    assert.ok((await store.getPet('pet'))?.[marker]);
  });

  test(`${action} fence failure still waits for Host stop and never claims a final marker`, async t => {
    const host = deferred();
    t.after(() => host.resolve());
    const { registry, store, assembled, closes } = await setup(t, () => host.promise, {
      // Exercise synchronous failure too: it must not prevent runtime.close.
      deactivateInstance: () => { throw new Error('Channel fence failed'); },
    });
    let failure: unknown;
    let returned = false;
    const pending = ending(registry).catch(error => { failure = error; }).finally(() => { returned = true; });
    await tick();
    assert.equal(closes(), 1);
    assert.equal(returned, false, 'an early fence rejection cannot abandon an unsettled Host stop');
    await assert.rejects(registry.reopenInstance('pet'), (error: { code?: string }) => error.code === 'busy');
    host.resolve();
    await pending;
    assert.match(String(failure), /Channel fence failed/);
    assert.equal((await store.getPet('pet'))?.[marker], undefined);
    assert.equal(registry.getLive('pet'), undefined);
    await assert.rejects(registry.reopenInstance('pet'), (error: { code?: string }) => error.code === 'busy');
    assert.equal(assembled.length, 1);
  });
}
