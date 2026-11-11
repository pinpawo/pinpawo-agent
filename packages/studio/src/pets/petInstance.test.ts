import assert from 'node:assert/strict';
import test from 'node:test';
import { PetInstance, type LiveStudioPet } from './petInstance';
import { StudioPetRegistry } from './studioPets';
import type { PetStore } from './store/petStore';
import type { StudioPetCredentials } from './petCredentials';
import type { StudioPet, StudioPetRegistration, StudioPetRuntime } from '../types';

const row: StudioPet = { petId: 'pet', definitionId: 'worker', channelId: 'one', name: 'Pet', createdAt: '2026-11-10' };
const busy = (error: { code?: string }) => error.code === 'busy';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(close: () => Promise<void> = async () => {}) {
  const assembled: StudioPetRegistration[] = [], events: string[] = [];
  let observed: LiveStudioPet | undefined, closes = 0;
  const source = { ...row };
  const instance = new PetInstance(source, {
    assemble: async pet => {
      assembled.push(pet);
      return { close: async () => { closes++; await close(); }, dispatch: {} } as StudioPetRuntime;
    },
    onLive: pet => { observed = pet; }, onClosed: () => { events.push('stopped'); },
    onChange: type => { events.push(type); },
  });
  return { instance, source, assembled, events, observed: () => observed, closes: () => closes };
}

test('one identity owns activation and runtime rename, using fresh names on Reopen', async () => {
  const { instance, source, assembled, observed } = fixture();
  source.channelId = 'another'; source.petId = 'another';
  await instance.restore(row);
  await assert.rejects(instance.restore(row), busy);
  const live = observed();
  instance.rename('Renamed');
  assert.equal(live?.registration.name, 'Renamed', 'update the already-observed registration');
  let closed!: StudioPet;
  await instance.end(row, 'close', true, async ended => { closed = ended; }).promise;
  const fresh = { ...closed, name: 'Persisted name' };
  await instance.reopen(fresh, async () => {}).promise;
  assert.equal(instance.petId, row.petId);
  assert.equal(instance.ownerChannelId, row.channelId);
  assert.deepEqual(assembled.map(pet => [pet.petId, pet.channelId, pet.createdAt]), [
    [row.petId, row.channelId, row.createdAt], [row.petId, row.channelId, row.createdAt],
  ]);
  assert.equal(assembled[1].name, fresh.name, 'mutable persisted metadata is not a second cached authority');
  await instance.shutdown();
});

for (const kind of ['close', 'remove'] as const) {
  test(`${kind} owns consent, admission fencing, coalescing, busy rules and stop-before-commit`, async () => {
    const stop = deferred();
    const { instance, events, closes } = fixture(() => stop.promise);
    await instance.restore(row);
    assert.throws(() => instance.end(row, kind, false, async () => {}), (e: { code?: string }) => e.code === 'confirmation_required');
    assert.ok(instance.live); assert.equal(instance.pending, undefined);
    let persisted: StudioPet | undefined;
    const first = instance.end(row, kind, true, async ended => { persisted = ended; events.push('persisted'); });
    const duplicate = instance.end(row, kind, false, async () => { assert.fail('duplicate persistence'); });
    assert.equal(duplicate.promise, first.promise);
    assert.equal(instance.live, undefined);
    assert.throws(() => instance.end(row, kind === 'close' ? 'remove' : 'close', true, async () => {}), busy);
    assert.throws(() => instance.reopen(row, async () => {}), busy);
    assert.throws(() => instance.rename('Busy'), busy);
    await tick();
    assert.equal(closes(), 1); assert.equal(persisted, undefined); assert.deepEqual(events, []);
    stop.resolve();
    const ended = await first.promise;
    assert.ok(ended[kind === 'close' ? 'closedAt' : 'removedAt']);
    assert.deepEqual(events, ['stopped', 'persisted', kind === 'close' ? 'pet.closed' : 'pet.removed']);
    assert.equal(instance.pending, undefined);
    if (kind === 'remove') assert.throws(() => instance.reopen(ended, async () => {}), /permanently removed/);
  });

  test(`uncertain ${kind} persistence uses the fresh final record on explicit retry without a success event`, async () => {
    const { instance, events, closes } = fixture();
    await instance.restore(row);
    let persisted!: StudioPet;
    await assert.rejects(instance.end(row, kind, true, async ended => {
      persisted = ended; throw new Error('ack lost');
    }).promise, /ack lost/);
    assert.deepEqual(events, ['stopped']);
    assert.equal(instance.live, undefined);
    assert.deepEqual(await instance.end(persisted, kind, false, async () => { assert.fail('already committed'); }).promise, persisted);
    assert.equal(closes(), 1);
  });
}

test('failed stop and failed-Reopen cleanup retain the runtime until a confirmed stop settles', async () => {
  let fail = true;
  const { instance, assembled, events } = fixture(async () => { if (fail) throw new Error('stop unknown'); });
  await instance.restore(row);
  await assert.rejects(instance.end(row, 'close', true, async () => { assert.fail('not settled'); }).promise, /stop unknown/);
  await assert.rejects(instance.restore(row), busy);
  assert.throws(() => instance.reopen(row, async () => {}), busy);
  fail = false;
  let closed!: StudioPet;
  await instance.end(row, 'close', true, async ended => { closed = ended; }).promise;
  fail = true;
  await assert.rejects(instance.reopen(closed, async () => { throw new Error('write failed'); }).promise, /stop unknown/);
  assert.throws(() => instance.reopen(closed, async () => {}), busy);
  assert.throws(() => instance.end(closed, 'close', false, async () => {}), (e: { code?: string }) => e.code === 'confirmation_required');
  assert.equal(assembled.length, 2); assert.equal(instance.live, undefined);
  assert.equal(events.includes('pet.reopened'), false);
  fail = false;
  await instance.end(closed, 'close', true, async () => {}).promise;
  await instance.reopen(closed, async () => {}).promise;
  assert.equal(assembled.length, 3);
  await instance.shutdown();
});


test('registry keeps restoration, cross-instance scheduling, pending dedupe and shutdown order', { timeout: 5000 }, async () => {
  const stopping = deferred(), activating = deferred();
  const rows = new Map([[row.petId, { ...row }], ['closed', { ...row, petId: 'closed', closedAt: 'closed' }]]);
  let failRead = false, reopening = false, closes = 0;
  const assembled: StudioPetRegistration[] = [];
  const store = {
    listPets: async () => [...rows.values()].map(pet => ({ ...pet })),
    getPet: async (id: string) => { if (failRead && id === row.petId) throw new Error('read failed'); return rows.get(id); },
    createPet: async (pet: StudioPet) => { if (rows.has(pet.petId)) return false; rows.set(pet.petId, { ...pet }); return true; },
    renamePet: async (id: string, name: string) => { rows.get(id)!.name = name; },
    closePet: async (id: string, closedAt: string) => { rows.get(id)!.closedAt = closedAt; },
    reopenPet: async (id: string) => { delete rows.get(id)!.closedAt; },
  } as PetStore;
  const registry = new StudioPetRegistry({ studioId: 'entity-test', store: async () => store, credentials: {} as StudioPetCredentials,
    definitions: [{ definitionId: row.definitionId, name: 'Worker' }], requireChannel: async () => {},
    assemble: async pet => {
      assembled.push(pet);
      if (reopening && pet.petId === row.petId) await activating.promise;
      return { dispatch: {}, close: async () => { closes++; if (!reopening && pet.petId === row.petId) await stopping.promise; } } as StudioPetRuntime;
    }, onLive: () => {}, onClosed: () => {}, onChange: () => {},
  });
  try {
    await Promise.all([registry.restore(), registry.restore()]);
    assert.equal(assembled.length, 1, 'restore only active identities once');
    await registry.create({ ...row, petId: 'other', channelId: 'two' });
    await assert.rejects(registry.closeInstance(row.petId), (e: { code?: string }) => e.code === 'confirmation_required');
    assert.ok(registry.getLive(row.petId));
    const closing = registry.closeInstance(row.petId, { confirmStop: true });
    await tick(); failRead = true;
    const duplicate = registry.closeInstance(row.petId);
    await assert.rejects(registry.removeInstance(row.petId, { confirmStop: true }), busy);
    await registry.rename('other', 'Other renamed');
    assert.equal(closes, 1, 'slow stop does not block another instance or repeat a stop');
    failRead = false; stopping.resolve();
    assert.deepEqual(await closing, await duplicate, 'pending dedupe never consults the failing store');
    reopening = true;
    const reopened = registry.reopenInstance(row.petId), again = registry.reopenInstance(row.petId);
    await tick();
    const shutdown = registry.close();
    assert.equal(closes, 1, 'shutdown waits for the pending activation');
    activating.resolve();
    assert.deepEqual(await reopened, await again);
    await shutdown;
    assert.equal(assembled.length, 3, 'repeated Reopen assembles only once');
    assert.equal(closes, 3, 'shutdown closes both remaining runtimes');
    assert.equal(registry.listLive().length, 0);
    assert.equal(rows.get(row.petId)?.closedAt, undefined, 'shutdown does not write Close');
  } finally { stopping.resolve(); activating.resolve(); await registry.close(); }
});

test('failed activation cleanup retains the only runtime until a confirmed stop actually settles', async () => {
  let recorded: StudioPet | undefined, assembled = 0, failActivation = true, failStop = true, detached = 0;
  const running = new Set<number>();
  const store = {
    listPets: async () => [], getPet: async () => recorded && { ...recorded },
    createPet: async (pet: StudioPet) => { recorded = { ...pet }; return true; },
    closePet: async (_id: string, closedAt: string) => { recorded!.closedAt = closedAt; },
    reopenPet: async () => { delete recorded!.closedAt; },
  } as unknown as PetStore;
  const registry = new StudioPetRegistry({ studioId: 'failed-activation', store: async () => store, credentials: {} as StudioPetCredentials,
    definitions: [{ definitionId: row.definitionId, name: 'Worker' }], requireChannel: async () => {},
    assemble: async () => {
      const handle = ++assembled; running.add(handle);
      return { dispatch: {}, close: async () => { if (failStop) throw new Error('cleanup unknown'); running.delete(handle); } } as StudioPetRuntime;
    }, onLive: () => { if (failActivation) throw new Error('activation callback failed'); },
    onClosed: () => { detached++; }, onChange: () => {},
  });
  try {
    await assert.rejects(registry.create(row), /cleanup unknown/);
    assert.ok(recorded?.closedAt);
    assert.equal(registry.getLive(row.petId), undefined);
    assert.equal(assembled, 1); assert.deepEqual([...running], [1]);
    failActivation = false;
    await assert.rejects(registry.reopenInstance(row.petId), busy);
    assert.equal(detached, 0, 'do not stop observing an unsettled runtime');
    await assert.rejects(registry.closeInstance(row.petId), (e: { code?: string }) => e.code === 'confirmation_required');
    await assert.rejects(registry.closeInstance(row.petId, { confirmStop: true }), /cleanup unknown/);
    assert.equal(assembled, 1, 'neither Reopen nor an older closed marker loses the first handle');
    failStop = false;
    await registry.closeInstance(row.petId, { confirmStop: true });
    assert.equal(running.size, 0); assert.equal(detached, 1);
    const reopened = await registry.reopenInstance(row.petId);
    assert.equal(reopened.petId, row.petId); assert.equal(reopened.channelId, row.channelId);
    assert.equal(assembled, 2); assert.deepEqual([...running], [2]);
  } finally { failStop = false; await registry.close(); }
});

for (const field of ['petId', 'definitionId', 'channelId', 'createdAt'] as const) {
  test(`fresh records cannot change immutable ${field} through lifecycle controls`, async () => {
    const { instance, assembled, closes } = fixture();
    const foreign = { ...row, [field]: 'different' };
    const invalid = (error: { code?: string }) => error.code === 'invalid';
    await assert.rejects(instance.restore(foreign), invalid);
    await assert.rejects(instance.create(foreign, async () => { assert.fail('must not persist'); }), invalid);
    await instance.restore(row);
    assert.throws(() => instance.end(foreign, 'close', true, async () => { assert.fail('must not persist'); }), invalid);
    assert.throws(() => instance.reopen({ ...foreign, closedAt: 'closed' }, async () => {}), invalid);
    assert.equal(assembled.length, 1);
    assert.equal(closes(), 0);
    await instance.shutdown();
  });
}

test('loading closed or removed rows never activates or rewrites them', async () => {
  const { instance, assembled } = fixture();
  for (const ended of [{ ...row, closedAt: 'closed' }, { ...row, removedAt: 'removed' }]) {
    await assert.rejects(instance.restore(ended), /not active/);
    await assert.rejects(instance.create(ended, async () => { assert.fail('must not persist'); }), /not active/);
  }
  assert.deepEqual(assembled, []);
});

test('first activation reserves the instance before assembly and rejects competing controls', async () => {
  const { instance, assembled } = fixture();
  const created = instance.create(row, async () => { assert.fail('successful assembly'); });
  assert.ok(instance.pending);
  const restoring = assert.rejects(instance.restore(row), busy);
  const creating = assert.rejects(instance.create(row, async () => { assert.fail('must not mark a live instance closed'); }), busy);
  assert.throws(() => instance.end(row, 'close', true, async () => {}), busy);
  await Promise.all([created, restoring, creating]);
  assert.equal(instance.pending, undefined);
  assert.equal(assembled.length, 1);
  assert.ok(instance.live);
  await instance.shutdown();
});

for (const operation of ['create', 'restore', 'reopen'] as const) {
  test(`${operation} prepares before assembly and makes the instance available only after activation commits`, async () => {
    const preparing = deferred(), assembling = deferred(), persisting = deferred();
    const order: string[] = [];
    const admissions: Array<{ pending: boolean; current: boolean }> = [];
    let instance!: PetInstance;
    instance = new PetInstance(row, {
      prepare: async pet => { assert.equal(pet.petId, row.petId); order.push('prepare'); await preparing.promise; },
      assemble: async () => {
        order.push('assemble');
        await assembling.promise;
        return { dispatch: {}, close: async () => {} } as StudioPetRuntime;
      },
      onLive: () => { order.push('resident'); assert.equal(instance.live, undefined); },
      onAvailable: live => {
        order.push('available');
        admissions.push({ pending: !!instance.pending, current: instance.live === live });
      },
      onClosed: () => {}, onChange: () => {},
    });
    const pending = operation === 'create'
      ? instance.create(row, async () => assert.fail('successful creation'))
      : operation === 'restore' ? instance.restore(row)
        : instance.reopen({ ...row, closedAt: 'closed' }, async () => { order.push('persist'); await persisting.promise; }).promise;
    try {
      await tick();
      assert.deepEqual(order, ['prepare']);
      assert.equal(instance.live, undefined);
      preparing.resolve();
      await tick();
      assert.deepEqual(order, ['prepare', 'assemble']);
      // A message arriving during assembly must not cause delivery yet.
      assert.equal(instance.live, undefined);
      assembling.resolve();
      await tick();
      if (operation === 'reopen') {
        assert.deepEqual(order, ['prepare', 'assemble', 'resident', 'persist']);
        assert.equal(instance.live, undefined, 'Reopen is not live before its write succeeds');
        persisting.resolve();
      }
      await pending;
      assert.deepEqual(order, operation === 'reopen'
        ? ['prepare', 'assemble', 'resident', 'persist', 'available']
        : ['prepare', 'assemble', 'resident', 'available']);
      assert.deepEqual(admissions, [{ pending: false, current: true }], 'consumer admission sees the current resident after the transition');
    } finally {
      preparing.resolve(); assembling.resolve(); persisting.resolve();
      await instance.shutdown();
    }
  });
}

test('failed preparation, assembly or Reopen persistence never admits Channel consumption', async () => {
  for (const failure of ['prepare', 'assemble', 'persist'] as const) {
    let admitted = 0, closed: StudioPet | undefined, stops = 0;
    const instance = new PetInstance(row, {
      prepare: async () => { if (failure === 'prepare') throw new Error('prepare failed'); },
      assemble: async () => {
        if (failure === 'assemble') throw new Error('assembly failed');
        return { dispatch: {}, close: async () => { stops++; } } as StudioPetRuntime;
      },
      onLive: () => {}, onAvailable: () => { admitted++; }, onClosed: () => {}, onChange: () => {},
    });
    try {
      if (failure === 'persist') {
        await assert.rejects(instance.reopen({ ...row, closedAt: 'closed' }, async () => { throw new Error('persist failed'); }).promise, /persist failed/);
        assert.equal(stops, 1, 'a failed Reopen write tears down its replacement runtime');
      } else {
        await assert.rejects(instance.create(row, async ended => { closed = ended; }), new RegExp(`${failure === 'prepare' ? 'prepare' : 'assembly'} failed`));
        assert.ok(closed?.closedAt, 'failed initial creation reserves a closed identity');
      }
      assert.equal(instance.live, undefined);
      assert.equal(admitted, 0, `${failure} failure must not wake a consumer`);
    } finally { await instance.shutdown(); }
  }
});

for (const kind of ['close', 'remove'] as const) {
  test(`${kind} synchronously cancels admission, then waits for both the fence and Host stop`, async () => {
    const fence = deferred(), stopped = deferred();
    const order: string[] = [];
    let persisted = false, instance!: PetInstance;
    instance = new PetInstance(row, {
      prepare: async () => {},
      assemble: async () => ({ dispatch: {}, close: async () => { order.push('stop'); await stopped.promise; } }) as StudioPetRuntime,
      deactivate: () => { order.push('cancel'); assert.equal(instance.live, undefined); return fence.promise; },
      onLive: () => {}, onAvailable: () => {}, onClosed: () => {}, onChange: () => {},
    });
    try {
      await instance.restore(row);
      assert.throws(() => instance.end(row, kind, false, async () => {}), (error: { code?: string }) => error.code === 'confirmation_required');
      assert.deepEqual(order, [], 'refused stop does not cancel a live consumer');
      const pending = instance.end(row, kind, true, async () => { persisted = true; });
      assert.deepEqual(order, ['cancel'], 'local admission closes in the same call stack');
      await tick();
      assert.deepEqual(order, ['cancel', 'stop']);
      stopped.resolve();
      await tick();
      assert.equal(persisted, false, 'Host stop alone does not bypass the Channel fence');
      fence.resolve();
      await pending.promise;
      assert.equal(persisted, true);
    } finally { fence.resolve(); stopped.resolve(); await instance.shutdown(); }
  });
}

test('failed first assembly retains identity for explicit recovery even when closing the record fails', async () => {
  let attempts = 0;
  const instance = new PetInstance(row, {
    assemble: async () => {
      if (++attempts === 1) throw new Error('assembly failed');
      return { dispatch: {}, close: async () => {} } as StudioPetRuntime;
    },
    onLive: () => {}, onClosed: () => {}, onChange: () => {},
  });
  let closed!: StudioPet;
  await assert.rejects(instance.create(row, async ended => {
    closed = ended;
    throw new Error('write acknowledgment lost');
  }), /write acknowledgment lost/);
  assert.equal(closed.petId, row.petId);
  assert.equal(closed.channelId, row.channelId);
  assert.ok(closed.closedAt);
  assert.equal(instance.live, undefined);
  await assert.rejects(instance.restore(row), busy);
  assert.throws(() => instance.reopen(row, async () => {}), busy);
  await instance.reopen(closed, async () => {}).promise;
  assert.equal(attempts, 2);
  assert.ok(instance.live);
  await instance.shutdown();
});

test('registry recovers a failed create whose closed marker was never committed', async () => {
  let recorded: StudioPet | undefined, assemblies = 0, rejectClose = true;
  const events: string[] = [];
  const store = {
    listPets: async () => [],
    getPet: async () => recorded && { ...recorded },
    createPet: async (pet: StudioPet) => {
      if (recorded) return false;
      recorded = { ...pet };
      return true;
    },
    closePet: async (_id: string, closedAt: string) => {
      if (rejectClose) throw new Error('close not committed');
      recorded!.closedAt = closedAt;
    },
    reopenPet: async () => { delete recorded!.closedAt; },
  } as unknown as PetStore;
  const registry = new StudioPetRegistry({
    studioId: 'failed-create-write', store: async () => store, credentials: {} as StudioPetCredentials,
    definitions: [{ definitionId: row.definitionId, name: 'Worker' }], requireChannel: async () => {},
    assemble: async () => {
      if (++assemblies === 1) throw new Error('assembly failed');
      return { dispatch: {}, close: async () => {} } as StudioPetRuntime;
    },
    onLive: () => {}, onClosed: () => {}, onChange: type => { events.push(type); },
  });
  try {
    await assert.rejects(registry.create(row), /close not committed/);
    assert.equal(recorded?.closedAt, undefined);
    assert.equal(registry.getLive(row.petId), undefined);
    await assert.rejects(registry.create(row), (error: { code?: string }) => error.code === 'exists');
    await assert.rejects(registry.reopenInstance(row.petId), busy);
    assert.equal(assemblies, 1);
    assert.deepEqual(events, []);
    rejectClose = false;
    await registry.closeInstance(row.petId);
    await registry.reopenInstance(row.petId);
    assert.equal(assemblies, 2);
    assert.deepEqual(events, ['pet.closed', 'pet.reopened']);
    assert.ok(registry.getLive(row.petId));
    assert.equal(recorded?.channelId, row.channelId);
  } finally { await registry.close(); }
});
