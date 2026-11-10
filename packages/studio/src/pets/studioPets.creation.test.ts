import assert from 'node:assert/strict';
import test from 'node:test';
import { StudioPetRegistry } from './studioPets';
import type { PetStore } from './store/petStore';
import type { StudioPetCredentials } from './petCredentials';
import type { StudioPet, StudioPetRuntime } from '../types';

const input = { petId: 'new', definitionId: 'worker', name: 'New', channelId: 'one' };
const existing: StudioPet = { ...input, petId: 'existing', createdAt: '2026-11-10' };

function fixture(list: () => Promise<StudioPet[]> = async () => [{ ...existing }]) {
  const rows = new Map([[existing.petId, { ...existing }]]);
  const assembled: string[] = [], closed: string[] = [], events: string[] = [];
  let reads = 0;
  const store = {
    listPets: async () => { reads++; return list(); },
    createPet: async (pet: StudioPet) => {
      if (rows.has(pet.petId)) return false;
      rows.set(pet.petId, { ...pet });
      return true;
    },
  } as PetStore;
  const registry = new StudioPetRegistry({
    studioId: 'creation-test', store: async () => store, credentials: {} as StudioPetCredentials,
    definitions: [{ definitionId: 'worker', name: 'Worker' }], requireChannel: async () => {},
    assemble: async pet => {
      assembled.push(pet.petId);
      return { dispatch: {}, close: async () => { closed.push(pet.petId); } } as StudioPetRuntime;
    },
    onLive: () => {}, onClosed: () => {}, onChange: type => { events.push(type); },
  });
  return { registry, rows, assembled, closed, events, reads: () => reads };
}

// The operations below are called in one turn, with no sleeps between them.
// The timeout only bounds a regression; completion never depends on a timer.
for (const order of ['create-first', 'restore-first'] as const) {
  test(`${order}: create and startup restoration settle without waiting on their own queue`, { timeout: 5000 }, async () => {
    const { registry, assembled, events, reads } = fixture();
    const operations = order === 'create-first'
      ? [registry.create(input), registry.restore()]
      : [registry.restore(), registry.create(input)];
    await Promise.all(operations);
    assert.deepEqual(assembled, ['existing', 'new']);
    assert.deepEqual(events, ['pet.created']);
    assert.equal(reads(), 1);
    await registry.close();
  });
}

test('concurrent creates reserve each identity once and share startup restoration', { timeout: 5000 }, async () => {
  const { registry, assembled, events, reads } = fixture();
  const first = registry.create(input);
  const duplicate = assert.rejects(registry.create(input), (error: { code?: string }) => error.code === 'exists');
  const other = registry.create({ ...input, petId: 'other' });
  await Promise.all([first, duplicate, other, registry.restore()]);
  assert.deepEqual(assembled, ['existing', 'new', 'other']);
  assert.deepEqual(events, ['pet.created', 'pet.created']);
  assert.equal(reads(), 1);
  await registry.close();
});

test('failed restoration rejects waiting creates without inserting records or retrying startup', { timeout: 5000 }, async () => {
  const failure = new Error('startup read failed');
  const { registry, rows, assembled, events, reads } = fixture(async () => { throw failure; });
  await Promise.all([
    assert.rejects(registry.create(input), error => error === failure),
    assert.rejects(registry.restore(), error => error === failure),
  ]);
  await assert.rejects(registry.create({ ...input, petId: 'other' }), error => error === failure);
  assert.deepEqual([...rows.keys()], ['existing']);
  assert.deepEqual(assembled, []);
  assert.deepEqual(events, []);
  assert.equal(reads(), 1);
  await registry.close();
});

test('shutdown drains an already accepted create and restoration before stopping both runtimes', { timeout: 5000 }, async () => {
  const { registry, assembled, closed } = fixture();
  const created = registry.create(input);
  const restored = registry.restore();
  const shutdown = registry.close();
  await Promise.all([created, restored, shutdown]);
  assert.deepEqual(assembled, ['existing', 'new']);
  assert.deepEqual(closed, ['existing', 'new']);
  assert.equal(registry.listLive().length, 0);
  await assert.rejects(registry.create({ ...input, petId: 'late' }), /already shut down/);
});

test('create after shutdown of an unstarted registry rejects without starting restoration', async () => {
  const { registry, assembled, reads } = fixture();
  await registry.close();
  await assert.rejects(registry.create(input), /already shut down/);
  assert.equal(reads(), 0);
  assert.deepEqual(assembled, []);
});
