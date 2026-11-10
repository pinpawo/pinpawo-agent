import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createResidentPetHost, ResidentPetCoordinator } from '../residentPetHost';
import { buildHostRuntimeConfig } from '../config/runtimeConfig';
import { FileSaver } from '../fileSaver';
import { createTestModelProfileRegistry } from '../testing/modelProfiles';
import { HostToolkitInventoryStore } from '../toolkits/toolkitInventory';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('close waits for an active conversation and cancels conversation waiting behind dispatch', async () => {
  const coordinator = new ResidentPetCoordinator({ readSettledState: () => 'open' });
  const release = deferred();
  const started = deferred();
  const active = coordinator.enqueueDispatch(async () => { started.resolve(); await release.promise; });
  await started.promise;
  let ran = false;
  const waiting = coordinator.holdForConversation(async () => { ran = true; });
  const refused = assert.rejects(waiting, /clos|cancel/i);
  const closing = coordinator.close();
  release.resolve();
  await Promise.all([active, refused, closing]);
  assert.equal(ran, false);

  const other = new ResidentPetCoordinator({ readSettledState: () => 'open' });
  const finish = deferred();
  const conversation = other.holdForConversation(async () => { await finish.promise; throw new Error('failed active operation'); });
  const failed = assert.rejects(conversation, /failed active/);
  let closed = false;
  const closedPromise = other.close().then(() => { closed = true; });
  await tick();
  assert.equal(closed, false, 'noncooperative active work must settle before close');
  finish.resolve();
  await Promise.all([failed, closedPromise]);
  await other.close();
});

test('Host close cancels queued session changes and waits for the executing command', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'resident-close-'));
  const config = buildHostRuntimeConfig(root);
  const entered = deferred();
  const release = deferred();
  let block = false;
  let turns = 0;
  const host = await createResidentPetHost({
    petId: 'closing', petName: 'Closing', runtimeConfig: config,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'first' }, { modelProfileId: 'second' }]),
    capabilities: [], toolkitInventory: new HostToolkitInventoryStore(),
    checkpointer: new FileSaver(config.checkpointPath), sessionStatePath: config.tuiSessionPath,
    toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
    graphService: { readThreadState: async () => {
      if (block) { block = false; entered.resolve(); await release.promise; }
      return { messages: [], pendingInterrupt: null, acceptsResume: false, currentPlan: null };
    } } as never,
    runAgentTurn: async () => { turns++; return { status: 'completed', reply: '' }; },
  });
  t.after(async () => { release.resolve(); await host.close(); await rm(root, { recursive: true, force: true }); });
  const firstSnapshot = await host.interaction.snapshot();
  assert.equal(firstSnapshot.type, 'session.snapshot.result');
  if (firstSnapshot.type !== 'session.snapshot.result') throw new Error('missing snapshot');
  const original = firstSnapshot.snapshot.session.sessionId;
  await host.interaction.request({ type: 'session.new', requestId: 'setup' });
  const activeSnapshot = await host.interaction.snapshot();
  if (activeSnapshot.type !== 'session.snapshot.result') throw new Error('missing snapshot');
  const active = activeSnapshot.snapshot.session.sessionId;
  const before = await readFile(config.tuiSessionPath, 'utf8');
  block = true;
  const listing = host.interaction.request({ type: 'session.list', requestId: 'held-list' });
  await entered.promise;
  const requests = [
    host.interaction.request({ type: 'session.new', requestId: 'queued-new' }),
    host.interaction.request({ type: 'session.resume', requestId: 'queued-resume', sessionId: original }),
    host.interaction.request({ type: 'model.select', requestId: 'queued-model', sessionId: active, modelProfileId: 'second' }),
    host.interaction.request({ type: 'chat_request', requestId: 'queued-chat', message: 'must not execute' }),
  ];
  let closed = false;
  const closing = host.close().then(() => { closed = true; });
  await tick();
  assert.equal(closed, false, 'close must wait for the executing checkpoint read');
  release.resolve();
  await Promise.all([listing, ...requests, closing]);
  assert.equal(await readFile(config.tuiSessionPath, 'utf8'), before, 'queued new/resume/model must not mutate session state');
  assert.equal(turns, 0);
  await host.close();
  await assert.rejects(host.interaction.request({ type: 'session.new', requestId: 'after' }), /closed/);
});


test('close cancels a selected dispatch before its first execution microtask', async () => {
  const coordinator = new ResidentPetCoordinator({ readSettledState: () => 'open' });
  let turns = 0;
  const admitted = coordinator.enqueueDispatch(async () => { turns++; });
  const refused = assert.rejects(admitted, /clos|cancel/i);
  await Promise.all([coordinator.close(), refused]);
  assert.equal(turns, 0, 'selected but unstarted work must not begin after stop');
});

test('same-turn Host stop prevents a selected but unstarted Agent turn', async t => {
  const root = await mkdtemp(join(tmpdir(), 'resident-selected-close-'));
  const config = buildHostRuntimeConfig(root);
  let turns = 0;
  const host = await createResidentPetHost({
    petId: 'closing', petName: 'Closing', runtimeConfig: config,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'first' }]),
    capabilities: [], toolkitInventory: new HostToolkitInventoryStore(),
    checkpointer: new FileSaver(config.checkpointPath), sessionStatePath: config.tuiSessionPath,
    toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
    graphService: { readThreadState: async () => ({ messages: [], pendingInterrupt: null, acceptsResume: false, currentPlan: null }) } as never,
    runAgentTurn: async () => { turns++; return { status: 'completed', reply: '' }; },
  });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const admission = host.resident.dispatch.dispatch({ request: 'not yet started' });
  const closing = host.close();
  await Promise.all([admission, closing]);
  assert.equal(turns, 0);
});
