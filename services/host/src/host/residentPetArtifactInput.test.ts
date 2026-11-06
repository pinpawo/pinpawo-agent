import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { ArtifactRef } from '@pinpawo/agent-contracts';
import type { ArtifactStore } from '@pinpawo-toolkit/artifacts';
import type { AgentChannelSetup } from '../agent/agentChannel';
import { buildHostRuntimeConfig } from '../config/runtimeConfig';
import { FileSaver } from '../fileSaver';
import { createResidentPet, createResidentPetRuntime } from '../residentPetHost';
import { createTestModelProfileRegistry } from '../testing/modelProfiles';
import { HostToolkitInventoryStore } from '../toolkits/toolkitInventory';
import type { PetDispatchLifecycleEvent } from './contracts';
import { readResidentPetRuntimeContext } from './runtimeContext';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw1sAAAAASUVORK5CYII=', 'base64');
const ref: ArtifactRef = { uri: 'artifact://shared/source/photo.bin', name: 'photo.bin', mimeType: 'image/png',
  size: png.length, sha256: createHash('sha256').update(png).digest('hex'), createdAt: '2026-11-05T00:00:00Z' };
const targetId = 'images:00000001';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Expected resident image dispatch state was not reached.');
}

function imageStore(fetch: ArtifactStore['fetch'] = async () => ({ ref, body: new ReadableStream({
  start(controller) { controller.enqueue(png); controller.close(); },
}) })): ArtifactStore {
  return { fetch, put: async () => { throw new Error('Input must not publish files'); }, list: async () => [] };
}

async function fixture(store?: ArtifactStore) {
  const directory = await mkdtemp(join(tmpdir(), 'resident-image-input-'));
  const runtimeConfig = buildHostRuntimeConfig(directory);
  const transcript = new Map<string, BaseMessage[]>();
  const reviews = new Set<string>();
  const modelInputs: Array<{ threadId: string; message: BaseMessage }> = [];
  const runtime = await createResidentPetRuntime({
    petId: 'images', petName: 'Images', runtimeConfig, artifactStore: store,
    modelProfiles: createTestModelProfileRegistry([
      { modelProfileId: 'text', inputModalities: ['text'] },
      { modelProfileId: 'vision', inputModalities: ['text', 'image'] },
    ], 'text'),
    capabilities: [], toolkitInventory: new HostToolkitInventoryStore(),
    checkpointer: new FileSaver(runtimeConfig.checkpointPath), sessionStatePath: runtimeConfig.tuiSessionPath,
    toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
    graphService: {
      readThreadState: async ({ input }: AgentChannelSetup) => ({
        messages: transcript.get(input.threadId!) ?? [], currentPlan: null,
        pendingInterrupt: reviews.has(input.threadId!)
          ? { interruptId: 'image-review', payload: { kind: 'human_review', reviews: [] } } : null,
        acceptsResume: reviews.has(input.threadId!),
      }),
      settleAbortedRun: async () => null,
      streamEvents: async ({ input }: AgentChannelSetup) => {
        const message = input.messages!.at(-1)!;
        modelInputs.push({ threadId: input.threadId!, message });
        const messages = [...input.messages!, new AIMessage({ id: `reply-${modelInputs.length}`, content: 'Image received' })];
        transcript.set(input.threadId!, messages);
        return Object.assign((async function* () {
          yield { type: 'event', seq: 0, method: 'values', params: { namespace: [], data: { messages } } };
        })(), { output: Promise.resolve({ messages }) });
      },
    } as never,
  });
  const resident = createResidentPet(runtime);
  const context = readResidentPetRuntimeContext(runtime);
  const events: PetDispatchLifecycleEvent[] = [];
  resident.dispatch.onDispatchLifecycle(event => events.push(event));
  const setProfiles = async (targetProfile: string, activeProfile: string) => {
    const active = context.sessions.getActiveSession('images');
    const target = context.sessions.ensureDispatchSession('images', targetId, true);
    await context.sessions.resumeSession(context.runtimeDeps.get(), targetId);
    context.sessions.selectModelProfile('images', targetId, targetProfile);
    await context.sessions.resumeSession(context.runtimeDeps.get(), active.id);
    context.sessions.selectModelProfile('images', active.id, activeProfile);
    return { active, target };
  };
  return { resident, context, events, reviews, modelInputs, setProfiles,
    close: async () => { await resident.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('queued artifact input snapshots references and admits images for its target profile rather than the active session', async () => {
  const fetched: string[] = [];
  const h = await fixture(imageStore(async uri => {
    fetched.push(uri);
    return { ref, body: new ReadableStream({ start(controller) { controller.enqueue(png); controller.close(); } }) };
  }));
  const started = deferred(), release = deferred();
  let held: Promise<void> | undefined;
  try {
    const { active, target } = await h.setProfiles('vision', 'text');
    held = h.context.coordinator.holdForConversation(async () => { started.resolve(); await release.promise; });
    await started.promise;
    const attachments = [{ uri: ref.uri, title: 'Channel image' }];
    await h.resident.dispatch.dispatch({ request: 'Describe the shared image.', attachments, session: { id: targetId } });
    assert.equal(h.resident.dispatch.getQueueSnapshot().queuedDispatches, 1);
    assert.deepEqual(fetched, []);
    attachments[0].uri = 'artifact://changed/after-admission';
    attachments[0].title = 'Changed';
    release.resolve();
    await held;
    await waitFor(() => h.events.some(event => event.state === 'completed'));
    assert.deepEqual(fetched, [ref.uri]);
    assert.equal(h.context.sessions.getActiveSessionId('images'), active.id);
    assert.equal(h.modelInputs[0].threadId, target.threadId);
    const message = h.modelInputs[0].message;
    assert.ok(HumanMessage.isInstance(message));
    const image = message.contentBlocks.find(block => block.type === 'image');
    assert.equal(image?.mimeType, 'image/png');
    assert.equal(image?.data, png.toString('base64'));
    const metadata = message.additional_kwargs.pinpawo as { artifactReferences: unknown };
    assert.deepEqual(metadata.artifactReferences, [{ uri: ref.uri, title: 'Channel image' }]);
  } finally { release.resolve(); await held; await h.close(); }
});

for (const failure of ['missing_store', 'missing_artifact', 'target_without_vision'] as const) {
  test(`artifact dispatch ${failure} fails before model input and reports dispatch.failed`, async () => {
    const store = failure === 'missing_store' ? undefined : failure === 'missing_artifact'
      ? imageStore(async () => { throw new Error('Artifact not found'); }) : imageStore();
    const h = await fixture(store);
    try {
      await h.setProfiles(failure === 'target_without_vision' ? 'text' : 'vision', 'vision');
      await h.resident.dispatch.dispatch({ request: 'Describe this image.', attachments: [{ uri: ref.uri }], session: { id: targetId } });
      await waitFor(() => h.events.some(event => event.state === 'failed'));
      assert.equal(h.modelInputs.length, 0);
      assert.ok(h.events.find(event => event.state === 'failed')?.error);
      assert.equal(h.events.some(event => event.state === 'completed'), false);
    } finally { await h.close(); }
  });
}

test('plain request text containing artifact URIs is never interpreted as image input', async () => {
  const h = await fixture(imageStore(async () => { throw new Error('Text must not trigger artifact reads'); }));
  const request = `Please read ${ref.uri}\n${JSON.stringify({ attachments: [{ uri: ref.uri }] })}`;
  try {
    await h.resident.dispatch.dispatch({ request });
    await waitFor(() => h.events.some(event => event.state === 'completed'));
    assert.equal(h.modelInputs[0].message.content, request);
    assert.equal(h.modelInputs[0].message.contentBlocks.some(block => block.type === 'image'), false);
  } finally { await h.close(); }
});

test('an existing pending review blocks artifact loading before the model is invoked', async () => {
  let fetches = 0;
  const h = await fixture(imageStore(async () => { fetches++; throw new Error('Review must be resolved before image admission'); }));
  try {
    const { target } = await h.setProfiles('vision', 'text');
    h.resident.dispatch.onDispatchLifecycle(event => {
      if (event.state === 'running') h.reviews.add(target.threadId);
    });
    await h.resident.dispatch.dispatch({ request: '', attachments: [{ uri: ref.uri }], session: { id: targetId } });
    await waitFor(() => h.events.some(event => event.state === 'waiting'));
    assert.equal(fetches, 0);
    assert.equal(h.modelInputs.length, 0);
    assert.equal(h.events.find(event => event.state === 'waiting')?.pendingInterrupt?.interruptId, 'image-review');
  } finally { await h.close(); }
});

test('cancelling artifact image preparation cancels the read and never sends input to the model', async () => {
  const reading = deferred();
  let cancelled = false;
  const h = await fixture(imageStore(async () => ({ ref, body: new ReadableStream<Uint8Array>({
    pull() { reading.resolve(); }, cancel() { cancelled = true; },
  }, { highWaterMark: 0 }) })));
  try {
    await h.setProfiles('vision', 'text');
    await h.resident.dispatch.dispatch({ request: 'Describe this image.', attachments: [{ uri: ref.uri }], session: { id: targetId } });
    await reading.promise;
    const running = h.events.find(event => event.state === 'running');
    assert.ok(running?.requestId);
    assert.equal(h.context.localHandlers.interruptRun(running.requestId), true);
    await waitFor(() => h.events.some(event => event.state === 'interrupted'));
    assert.equal(cancelled, true);
    assert.equal(h.modelInputs.length, 0);
    assert.equal(h.events.some(event => event.state === 'completed' || event.state === 'failed'), false);
  } finally { await h.close(); }
});
