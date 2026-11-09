import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioStorage, type StudioStorageConfig } from '@pinpawo/studio-core';
import { createPglitePool } from '../../../tests/support/pglitePool';
import { ChannelService } from './channelService';
import { KyselyChannelStore, channelMigrations, type ChannelDatabase } from './store/kysely';

const owner = { kind: 'human' as const, id: 'owner' };
const pet = { kind: 'pet' as const, id: 'executor' };
const backends: Array<[string, () => StudioStorageConfig]> = [
  ['sqlite', () => ({ kind: 'sqlite', path: ':memory:' })],
  ['postgres', () => ({ kind: 'postgres', pool: createPglitePool() })],
];
for (const [backend, config] of backends) {
  async function withService(run: (service: ChannelService, store: KyselyChannelStore) => Promise<void>) {
    const storage = createStudioStorage(config());
    try {
      const store = new KyselyChannelStore(await storage.open<ChannelDatabase>('channel', channelMigrations(storage.dialect)));
      const service = new ChannelService({ store,
        pets: () => [{ petId: 'executor', name: 'Executor' }, { petId: 'reviewer', name: 'Reviewer' }],
        humans: async id => ({ label: id, active: true }),
      });
      await run(service, store);
    } finally { await storage.close(); }
  }

  test(`${backend}: activation baselines all current Pets, restart preserves backlog, reenable skips off-period`, () => withService(async (service, store) => {
    assert.equal(await store.getHeadEnabled(), undefined);
    const channels = [];
    for (let i = 0; i < 2; i++) {
      const { channelId } = (await service.createChannel(owner, { title: `Team ${i}`, pets: ['executor', 'reviewer'] })).channel;
      const before = await service.consumption(channelId, pet.id);
      const old = await service.postMessage(owner, channelId, { body: 'Router-era history' });
      channels.push({ channelId, before, old: old.message });
    }
    await service.configureHeadConsumption(true);
    assert.equal(await store.getHeadEnabled(), true);
    for (const { channelId, before, old } of channels) {
      for (const petId of ['executor', 'reviewer']) assert.equal((await service.consumption(channelId, petId)).afterSequence, old.sequence);
      const baseline = await service.consumption(channelId, pet.id);
      assert.notEqual(baseline.membershipId, before.membershipId);
      await service.postMessage(owner, channelId, { body: 'Pending work' });
      await service.configureHeadConsumption(true);
      assert.deepEqual(await service.consumption(channelId, pet.id), baseline);
    }
    await service.configureHeadConsumption(false);
    assert.equal(await store.getHeadEnabled(), false);
    const { channelId } = channels[0]!;
    const disabled = await service.consumption(channelId, pet.id);
    const off = await service.postMessage(owner, channelId, { body: 'While disabled' });
    await service.configureHeadConsumption(true);
    const resumed = await service.consumption(channelId, pet.id);
    assert.equal(resumed.afterSequence, off.message.sequence);
    assert.notEqual(resumed.membershipId, disabled.membershipId);
  }));

  test(`${backend}: provenance and addressing failure persist and public input cannot forge them`, () => withService(async (service, store) => {
    const { channelId } = (await service.createChannel(owner, { title: 'Team', pets: ['executor'] })).channel;
    for (const forged of [{ source: 'pet-head' }, { addressingError: 'invented' }]) {
      await assert.rejects(service.postMessage(pet, channelId, { body: 'Forged', ...forged }));
    }
    const historical = await store.appendMessage({
      channelId, messageId: 'historical', author: owner, occurredAt: new Date().toISOString(), body: 'Old message', mentions: [],
    });
    assert.equal((await service.getMessage(channelId, historical.messageId))?.source, undefined);
    const human = await service.postMessage(owner, channelId, { body: 'Hello' });
    assert.equal(human.message.source, 'member');
    for (const source of [undefined, 'pet-agent'] as const) {
      const result = await service.postMessage(pet, channelId, { body: '[@missing](participant:pet:missing)' }, { source });
      assert.ok(result.mentionError);
      assert.equal(result.message.addressingError, result.mentionError);
      assert.equal(result.message.source, source ?? 'member');
      assert.deepEqual(await service.getMessage(channelId, result.message.messageId), result.message);
    }
    const reply = await service.postMessage(pet, channelId, { body: 'Done' }, { source: 'pet-head', externalRef: 'head-reply' });
    assert.deepEqual(await store.getMessageByExternalRef(pet, 'head-reply'), reply.message);
    assert.equal(reply.message.source, 'pet-head');
    assert.equal(await store.getMessageByExternalRef(owner, 'head-reply'), undefined);
  }));

  test(`${backend}: obsolete membership cannot save Head replies and Head cannot address Pets`, () => withService(async (service) => {
    const { channelId } = (await service.createChannel(owner, { title: 'Team', pets: ['executor', 'reviewer'] })).channel;
    const before = await service.consumption(channelId, pet.id);
    await service.removeMember(owner, channelId, pet);
    await service.addMember(owner, channelId, pet);
    await assert.rejects(service.postMessage(pet, channelId, { body: 'Stale reply' }, { source: 'pet-head', membershipId: before.membershipId }), /membership changed/);
    const options = { source: 'pet-head' as const, membershipId: (await service.consumption(channelId, pet.id)).membershipId };
    for (const body of ['[@Reviewer](participant:pet:reviewer)', '[@missing](participant:pet:missing)']) {
      await assert.rejects(service.postMessage(pet, channelId, { body }, options));
    }
    await assert.rejects(service.postMessage(pet, channelId, { body: 'Review', mentions: [{ participantId: 'pet:reviewer' }] }, options));
    assert.equal((await service.readContext(owner, channelId)).messages.length, 0);
    const reply = await service.postMessage(pet, channelId, { body: '[@Owner](participant:human:owner)' }, options);
    assert.equal(reply.message.mentions[0]?.participantId, 'human:owner');
  }));
}
