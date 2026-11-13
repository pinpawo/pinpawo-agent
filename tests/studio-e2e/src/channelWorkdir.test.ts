import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChannelPlugin } from '@pinpawo-plugin/channel';
import { GENERAL_CAPABILITY_NAME, defineInstructionDocument } from '@pinpawo/pet-agent';
import { buildHostRuntimeConfig, FileSaver } from 'pinpawo/host-runtime';
import { buildStudio, resolveStudioHostConfig } from '../../../packages/studio/src/host/buildStudio';
import { createTestModelProfileRegistry } from '../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';

const human = { kind: 'human' as const, id: 'local' };

async function fixture(root: string) {
  const channel = createChannelPlugin({ httpRoute: false });
  const configuration = await resolveStudioHostConfig({ workdir: root, resolvePlugin: () => channel });
  const runtimeConfig = buildHostRuntimeConfig(root);
  return { channel, build: () => buildStudio({
    configuration,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    hostCapabilities: [{ name: GENERAL_CAPABILITY_NAME, description: 'General', uses: [],
      instructions: defineInstructionDocument({ content: '# General' }) }],
    petCapabilities: new Map(), toolkitInventory: new HostToolkitInventoryStore(),
    checkpoint: new FileSaver(path.join(runtimeConfig.stateRoot, 'checkpoints.json')),
    runtimeConfig, toolAuthorizationMode: 'require_authorization' as const,
    autoAuthorizationSafetyLevel: 'strict' as const,
  }) };
}

async function writeConfig(root: string) {
  const stateRoot = path.join(root, '.pinpawo');
  await mkdir(path.join(stateRoot, 'pets'), { recursive: true });
  await writeFile(path.join(stateRoot, 'pets', 'worker.json'), JSON.stringify({ definitionId: 'worker', name: 'Worker' }));
  await writeFile(path.join(stateRoot, 'studio.json'), JSON.stringify({
    studioId: 'channel-workdir', definitions: ['worker'], plugins: [{ id: 'channel' }],
  }));
}

async function snapshotCwd(result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['build']>>, petId: string) {
  const snapshot = await result.residentPetInteractions.get(petId)!.snapshot();
  assert.equal(snapshot.type, 'session.snapshot.result');
  if (snapshot.type !== 'session.snapshot.result') throw new Error('Expected a session snapshot');
  return { cwd: snapshot.snapshot.session.runtime?.cwd, stateRoot: snapshot.snapshot.session.runtime?.stateRoot };
}

test('Channel execution directories survive Pet reopen and Studio restart without moving Host state', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-channel-workdir-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeConfig(root);
  const aDir = path.join(root, 'project-a'), bDir = path.join(root, 'project-b');
  await Promise.all([mkdir(aDir), mkdir(bDir)]);
  const firstFixture = await fixture(root), first = await firstFixture.build();
  const a = (await firstFixture.channel.service.createChannel(human, { title: 'A', workdir: 'project-a' }, { studio: true })).channel.channelId;
  const b = (await firstFixture.channel.service.createChannel(human, { title: 'B', workdir: bDir }, { studio: true })).channel.channelId;
  const fallback = (await firstFixture.channel.service.createChannel(human, { title: 'Default' })).channel.channelId;
  try {
    for (const [petId, channelId] of [['a1', a], ['a2', a], ['b', b], ['default', fallback]]) {
      await first.studio.pets.create({ petId, channelId, definitionId: 'worker', name: petId });
    }
    const assertDirectories = async (studio: typeof first) => {
      const snapshots = await Promise.all(['a1', 'a2', 'b', 'default'].map(id => snapshotCwd(studio, id)));
      assert.deepEqual(snapshots.map(snapshot => snapshot.cwd), [aDir, aDir, bDir, root]);
      assert.ok(snapshots.every(snapshot => snapshot.stateRoot === path.join(root, '.pinpawo')));
    };
    await assertDirectories(first);
    await first.studio.pets.closeInstance('a1', { confirmStop: true });
    await first.studio.pets.reopenInstance('a1');
    await assertDirectories(first);
  } finally { await first.studio.shutdown(); }
  const secondFixture = await fixture(root), restored = await secondFixture.build();
  try {
    const snapshots = await Promise.all(['a1', 'a2', 'b', 'default'].map(id => snapshotCwd(restored, id)));
    assert.deepEqual(snapshots.map(snapshot => snapshot.cwd), [aDir, aDir, bDir, root]);
    assert.ok(snapshots.every(snapshot => snapshot.stateRoot === path.join(root, '.pinpawo')));
  } finally { await restored.studio.shutdown(); }
});

test('invalid Channel directory preserves closed Pet and makes startup restoration fail with actionable context', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-channel-workdir-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeConfig(root);
  const project = path.join(root, 'project');
  const firstFixture = await fixture(root), first = await firstFixture.build();
  const channelId = (await firstFixture.channel.service.createChannel(human, { title: 'Broken', workdir: project }, { studio: true })).channel.channelId;
  const describesDirectory = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(message.includes(channelId), `missing Channel id in: ${message}`);
    assert.ok(message.includes(project), `missing directory in: ${message}`);
    return true;
  };
  try {
    await assert.rejects(first.studio.pets.create({ petId: 'failed', channelId, definitionId: 'worker', name: 'Failed' }), describesDirectory);
    const closedAt = (await first.studio.pets.get('failed'))?.closedAt;
    assert.ok(closedAt);
    await assert.rejects(first.studio.pets.reopenInstance('failed'), describesDirectory);
    assert.equal((await first.studio.pets.get('failed'))?.closedAt, closedAt);
    await mkdir(project);
    await first.studio.pets.reopenInstance('failed');
    assert.equal((await snapshotCwd(first, 'failed')).cwd, project);
  } finally { await first.studio.shutdown(); }
  await rm(project, { recursive: true });
  const secondFixture = await fixture(root);
  await assert.rejects(secondFixture.build(), describesDirectory);
});
