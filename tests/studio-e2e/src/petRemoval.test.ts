import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { buildReviewSpec } from '@pinpawo/pet-agent';
import { createStudio, prepareStudio } from '@pinpawo/studio-core';
import { createChannelPlugin } from '@pinpawo-plugin/channel';
import { createResidentPetHost, buildHostRuntimeConfig, FileSaver } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error('Timed out waiting for controlled runtime state.');
}
const human = { kind: 'human' as const, id: 'local' };

for (const action of ['close', 'remove'] as const) {
  const marker = action === 'close' ? 'closedAt' : 'removedAt';
  for (const entry of ['dispatch', 'conversation'] as const) {
    test(`confirmed ${action} waits for real ${entry} settlement and cancels every unstarted successor`, async t => {
      const root = await mkdtemp(join(tmpdir(), 'pet-remove-'));
      const config = buildHostRuntimeConfig(root);
      const started = deferred(), release = deferred();
      let aborted = false, turns = 0;
      const host = await createResidentPetHost({ petId: 'pet', petName: 'Pet', runtimeConfig: config,
        modelProfiles: createTestModelProfiles(), capabilities: [], toolkitInventory: new HostToolkitInventoryStore(),
        checkpointer: new FileSaver(config.checkpointPath), sessionStatePath: config.tuiSessionPath,
        toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
        graphService: { readThreadState: async () => ({ messages: [], pendingInterrupt: null, acceptsResume: false, currentPlan: null }),
          settleAbortedRun: async () => null } as never,
        runAgentTurn: async ({ setup }) => {
          turns++;
          setup.input.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
          started.resolve();
          await release.promise; // Deliberately noncooperative: abort is not proof of settlement.
          return { status: 'completed', reply: 'settled' };
        },
      });
      const channel = createChannelPlugin({ httpRoute: false });
      const studio = await createStudio({ studioId: 'remove-runtime', plugins: [channel],
        definitions: [{ definitionId: 'worker', name: 'Worker' }],
        assemblePet: async () => ({ dispatch: host.resident.dispatch, sessions: host.sessions, close: host.close }),
      });
      t.after(async () => { release.resolve(); await studio.shutdown(); await host.close(); await rm(root, { recursive: true, force: true }); });
      const channelId = (await channel.service.createChannel(human, { title: 'Owner' })).channel.channelId;
      await studio.pets.create({ petId: 'pet', definitionId: 'worker', name: 'Pet', channelId });
      const run = entry === 'dispatch'
        ? studio.dispatch({ petId: 'pet', request: 'current' })
        : host.interaction.request({ type: 'chat_request', requestId: 'conversation', message: 'current' });
      await started.promise;
      await studio.dispatch({ petId: 'pet', request: 'unstarted successor one' });
      await studio.dispatch({ petId: 'pet', request: 'unstarted successor two' });
      assert.equal(host.resident.dispatch.getQueueSnapshot().queuedDispatches, 2);
      const end = (confirmStop = false) => action === 'close' ? studio.pets.closeInstance('pet', { confirmStop }) : studio.pets.removeInstance('pet', { confirmStop });
      await assert.rejects(end(), (error: { code?: string }) => error.code === 'confirmation_required');
      assert.equal(aborted, false, 'missing consent must not stop anything');
      const removing = end(true);
      const repeated = end(true);
      await waitFor(() => aborted);
      assert.equal((await studio.pets.get('pet'))?.[marker], undefined, 'abort alone cannot commit a lifecycle state');
      assert.equal(studio.listPets().length, 0, 'pending removal fences new Studio admission');
      await assert.rejects(studio.dispatch({ petId: 'pet', request: 'late' }));
      release.resolve();
      const [removed, again] = await Promise.all([removing, repeated]);
      await run;
      assert.ok(removed[marker]);
      assert.deepEqual(again, removed);
      assert.equal(turns, 1, 'no canceled successor executes');
      await assert.rejects(host.interaction.request({ type: 'session.new', requestId: 'after' }), /clos/i);
      if (action === 'remove') await assert.rejects(studio.pets.reopenInstance('pet'), /permanently removed/);
    });
  }

  test(`${action} of a real waiting Host keeps the pending review as history without answering or resuming it`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'pet-remove-review-'));
    const config = buildHostRuntimeConfig(root);
    const review = buildReviewSpec({ id: 'review', view: { kind: 'plain', body: 'Approve?' },
      options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }] });
    const threads = new Map<string, { reviewing: boolean }>();
    const turns: string[] = [];
    const host = await createResidentPetHost({ petId: 'pet', petName: 'Pet', runtimeConfig: config,
      modelProfiles: createTestModelProfiles(), capabilities: [], toolkitInventory: new HostToolkitInventoryStore(),
      checkpointer: new FileSaver(config.checkpointPath), sessionStatePath: config.tuiSessionPath,
      toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
      graphService: { readThreadState: async (setup: { input: { threadId?: string } }) => {
        const reviewing = threads.get(setup.input.threadId ?? '')?.reviewing;
        return { messages: reviewing ? [new AIMessage('Needs approval')] : [],
          pendingInterrupt: reviewing ? { interruptId: 'pending', payload: { kind: 'human_review', reviews: [review] } } : null,
          acceptsResume: !!reviewing, currentPlan: null };
      }, settleAbortedRun: async () => null } as never,
      runAgentTurn: async ({ request, setup, emitEvent }) => {
        turns.push(request.kind);
        threads.set(setup.input.threadId ?? '', { reviewing: true });
        emitEvent({ type: 'interrupt.requested', requestId: request.requestId,
          pendingInterrupt: { interruptId: 'pending', payload: { kind: 'human_review', interactions: [] } } });
        return { status: 'waiting' };
      },
    });
    const channel = createChannelPlugin({ httpRoute: false });
    const studio = await createStudio({ studioId: 'remove-review', plugins: [channel],
      definitions: [{ definitionId: 'worker', name: 'Worker' }],
      assemblePet: async () => ({ dispatch: host.resident.dispatch, sessions: host.sessions, close: host.close }),
    });
    t.after(async () => { await studio.shutdown(); await host.close(); await rm(root, { recursive: true, force: true }); });
    const channelId = (await channel.service.createChannel(human, { title: 'Owner' })).channel.channelId;
    await studio.pets.create({ petId: 'pet', definitionId: 'worker', name: 'Pet', channelId });
    const sessionId = 'pet:00000001';
    await studio.dispatch({ petId: 'pet', request: 'needs review', session: { id: sessionId, create: true } });
    await waitFor(() => threads.size === 1 && host.resident.dispatch.getQueueSnapshot().activeOperation === null);
    const before = await host.sessions.snapshot(sessionId);
    assert.equal(before.session.pendingInterrupt?.interruptId, 'pending');
    await studio.dispatch({ petId: 'pet', request: 'unstarted', session: { id: sessionId } });
    assert.equal(host.resident.dispatch.getQueueSnapshot().queuedDispatches, 1);
    if (action === 'close') await studio.pets.closeInstance('pet', { confirmStop: true });
    else await studio.pets.removeInstance('pet', { confirmStop: true });
    assert.deepEqual(turns, ['user_message']);
    assert.ok([...threads.values()].every(thread => thread.reviewing));
    assert.match(await readFile(config.tuiSessionPath, 'utf8'), /pending/);
    await assert.rejects(host.sessions.review(sessionId, { requestId: 'late-review', interruptId: 'pending',
      value: { decisions: [{ interactionId: 'review', selectedOptionId: 'approve' }] } }), /closed/);
    assert.deepEqual(turns, ['user_message']);
  });

}


test('confirmed Close and Reopen rebuild a real Host on the same identity, owner and persisted Channel session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pet-close-reopen-'));
  const config = buildHostRuntimeConfig(join(root, 'pet'));
  const channel = createChannelPlugin({ httpRoute: false });
  const hosts: Awaited<ReturnType<typeof createResidentPetHost>>[] = [];
  let turns = 0;
  const reviewing = new Set<string>();
  const review = buildReviewSpec({ id: 'reopen-review', view: { kind: 'plain', body: 'Approve?' },
    options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }] });
  let prepared!: ReturnType<typeof prepareStudio>;
  prepared = prepareStudio({ studioId: 'close-reopen-runtime', plugins: [channel], credentialsKey: new Uint8Array(32).fill(7),
    definitions: [{ definitionId: 'worker', name: 'Worker' }],
    assemblePet: async () => {
      const host = await createResidentPetHost({ petId: 'pet', petName: 'Pet', runtimeConfig: config,
        modelProfiles: createTestModelProfiles(), capabilities: [], toolkitInventory: new HostToolkitInventoryStore(),
        checkpointer: new FileSaver(config.checkpointPath), sessionStatePath: config.tuiSessionPath,
        resolveInvocationContext: async target => prepared.resolveInvocationContext(target),
        toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
        graphService: { readThreadState: async (setup: { input: { threadId?: string } }) => {
          const pending = reviewing.has(setup.input.threadId ?? '');
          return { messages: [], pendingInterrupt: pending ? { interruptId: 'reopen-pending', payload: { kind: 'human_review', reviews: [review] } } : null,
            acceptsResume: pending, currentPlan: null };
        }, settleAbortedRun: async () => null } as never,
        runAgentTurn: async ({ setup, request, emitEvent }) => {
          turns++;
          if (turns === 2) {
            reviewing.add(setup.input.threadId ?? '');
            emitEvent({ type: 'interrupt.requested', requestId: request.requestId,
              pendingInterrupt: { interruptId: 'reopen-pending', payload: { kind: 'human_review', interactions: [] } } });
            return { status: 'waiting' };
          }
          return { status: 'completed', reply: 'settled' };
        },
      });
      hosts.push(host);
      return { dispatch: host.resident.dispatch, sessions: host.sessions, close: host.close };
    },
  });
  t.after(async () => { await prepared.studio.shutdown(); for (const host of hosts) await host.close(); await rm(root, { recursive: true, force: true }); });
  await prepared.activatePlugins();
  const { studio } = prepared;
  const channelId = (await channel.service.createChannel(human, { title: 'Owner' })).channel.channelId;
  const original = await studio.pets.create({ petId: 'pet', definitionId: 'worker', name: 'Pet', channelId });
  await studio.pets.credentials.set({ petId: 'pet', envName: 'TOKEN', value: 'local-test-value' });
  const send = (body: string) => channel.run(channelId, 'pet', body, { kind: 'trigger', id: 'test' });
  await send('Before Close.');
  await waitFor(() => turns === 1 && hosts[0]!.resident.dispatch.getQueueSnapshot().activeOperation === null);
  const binding = (await channel.service.getSession(channelId, 'pet'))!;
  assert.equal((await hosts[0]!.sessions.snapshot(binding.sessionId)).session.sessionId, binding.sessionId);
  const closed = await studio.pets.closeInstance('pet', { confirmStop: true });
  assert.ok(closed.closedAt);
  assert.equal(closed.removedAt, undefined);
  await assert.rejects(hosts[0]!.sessions.snapshot(binding.sessionId));
  const reopened = await studio.pets.reopenInstance('pet');
  assert.deepEqual(reopened, original);
  assert.equal(hosts.length, 2, 'Reopen assembles a new runtime for the same identity');
  assert.equal((await channel.service.getSession(channelId, 'pet'))?.sessionId, binding.sessionId);
  assert.equal((await hosts[1]!.sessions.snapshot(binding.sessionId)).session.sessionId, binding.sessionId);
  assert.deepEqual(await prepared.credentialSource.environment('pet'), { TOKEN: 'local-test-value' });
  await send('Explicit work after Reopen.');
  await waitFor(() => turns === 2 && hosts[1]!.resident.dispatch.getQueueSnapshot().activeOperation === null);
  assert.equal(turns, 2);
  assert.equal((await hosts[1]!.sessions.snapshot(binding.sessionId)).session.pendingInterrupt?.interruptId, 'reopen-pending');
  await studio.dispatch({ petId: 'pet', request: 'unstarted review successor', session: { id: binding.sessionId } });
  await studio.pets.closeInstance('pet', { confirmStop: true });
  await studio.pets.reopenInstance('pet');
  assert.equal(hosts.length, 3);
  assert.equal(turns, 2, 'Reopen neither replays canceled work nor automatically answers a review');
  assert.equal((await hosts[2]!.sessions.snapshot(binding.sessionId)).session.pendingInterrupt?.interruptId, 'reopen-pending');
});
