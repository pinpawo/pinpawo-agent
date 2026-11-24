import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { defineInstructionDocument, GENERAL_CAPABILITY_NAME } from '@pinpawo/pet-agent';
import { buildHostRuntimeConfig, FileSaver, type PetDispatchQueueSnapshot, type PetDispatchRequest } from 'pinpawo/host-runtime';
import { buildStudio } from '../../../packages/studio/src/host/buildStudio';
import { resolveStudio } from '../../../packages/studio/src/host/studioConfig';
import type { HeadInput, HeadMessage } from '../../../packages/studio/src/host/petHead';
import type { StudioEventSubscriptionFilter, StudioModelEndpoint, StudioPlugin } from '../../../packages/studio/src/studioContract';
import { createChannelPlugin } from '../../../plugins/channel/src/channelPlugin';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';

const human = { kind: 'human' as const, id: 'local' };

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the owner Head.');
}

test('production Head stays scoped to its Channel, samples only live runs, and does not republish results', async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), 'head-topic-e2e-'));
  const channel = createChannelPlugin({ httpRoute: false });
  const decisions: Record<string, string[]> = { alpha: [], beta: [] };
  const deliveries: Record<string, string[]> = { alpha: [], beta: [] };
  const published: Array<{ topic: string | undefined; message: HeadMessage }> = [];
  const composeInputs: Array<{ evidence: unknown }> = [];
  const runningCalls: Array<{ messageId: string; execution: unknown; client: number }> = [];
  const startA = 'Start work A.';
  const direct = '[@alpha](participant:pet:alpha) Are you the analyst?';
  const progress = '[@alpha](participant:pet:alpha) How is A going?';
  const mixed = '[@alpha](participant:pet:alpha) How is A going? Also do work B.';
  const interimA = 'Published evidence for work A.';
  const finalA = 'This is A’s official result.';
  const canonicalDecisions: HeadInput[] = [];
  const held = '[@alpha](participant:pet:alpha) Hold Head judgment through close.';
  const factoryCalls: number[] = [];
  const decisionClients: Array<{ body: string; client: number }> = [];
  let resolutionCount = 0;
  let heldSignal: AbortSignal | undefined;
  let releaseHeld!: () => void;
  const holdJudgment = new Promise<void>(resolve => { releaseHeld = resolve; });
  type Messages = Array<[string, string]>;
  type DecisionSchema = { safeParse(input: unknown): { success: boolean } };
  const createModel = () => {
    const client = factoryCalls.length;
    factoryCalls.push(client);
    return {
      withStructuredOutput: (schema: DecisionSchema, options: { name: string; method: string; includeRaw: boolean }) => {
        assert.ok(['pet_head_relevance', 'pet_head_idle', 'pet_head_running'].includes(options.name));
        assert.equal(options.method, 'jsonMode');
        assert.equal(options.includeRaw, true);
        return {
          invoke: async (messages: Messages, { signal }: { signal: AbortSignal }) => {
            const input = JSON.parse(messages[1]![1]) as HeadInput & { execution?: unknown };
            const { pet, message, addressed } = input;
            if (options.name === 'pet_head_running') {
              runningCalls.push({ messageId: message.messageId, execution: input.execution, client });
              assert.doesNotMatch(JSON.stringify(input), /dispatchId|sessionId|queuedDispatches|opaque-live-request|private checkpoint text|private tool output/);
              const parsed = { delivery: null, reply: 'A is still running.' };
              assert.equal(schema.safeParse(parsed).success, true);
              return { raw: new AIMessage(JSON.stringify(parsed)), parsed };
            }
            if (options.name === 'pet_head_relevance' || addressed) decisions[pet.petId]!.push(message.body);
            decisionClients.push({ body: message.body, client });
            if (addressed) canonicalDecisions.push(input);
            if (message.body === held) { heldSignal = signal; await holdJudgment; }
            const dispatch = [startA, mixed, held].includes(message.body);
            const reply = message.body === direct ? 'Yes, I am.' : message.body === held ? 'This reply is too late.' : '';
            const parsed = options.name === 'pet_head_relevance'
              ? { relevant: [startA, mixed, held, progress, direct].includes(message.body) }
              : { shouldDispatch: dispatch, reply: reply || null };
            assert.equal(schema.safeParse(parsed).success, true);
            return { raw: new AIMessage(JSON.stringify(parsed)), parsed };
          },
        };
      },
      invoke: async (messages: Messages) => {
        const input = JSON.parse(messages[1]![1]);
        composeInputs.push(input);
        return new AIMessage(input.evidence.status === 'waiting' ? 'Waiting for review.' : 'I cannot verify the current status.');
      },
    } as unknown as ReturnType<NonNullable<StudioModelEndpoint['createChatModel']>>;
  };
  const scriptedModels: StudioPlugin = {
    name: 'scripted-head-models', toolkits: [],
    start: context => {
      // Replace only the model transport; buildStudio still owns Head assembly.
      context.models.resolve = () => {
        resolutionCount++;
        return {
          profileId: 'test', baseUrl: 'https://models.example.test/v1', apiKey: 'test-key', model: 'scripted',
          structuredOutputMethod: 'jsonMode', createChatModel: createModel,
        };
      };
    },
  };
  let result: Awaited<ReturnType<typeof buildStudio>> | undefined;
  try {
    result = await buildStudio({
      configuration: {
        workdir,
        studioConfigPath: path.join(workdir, '.pinpawo', 'studio.json'),
        petsDir: path.join(workdir, '.pinpawo', 'pets'),
        resolved: resolveStudio({
          studioId: 'head-topic', definitions: ['worker'], storage: { kind: 'sqlite', path: ':memory:' },
        }, [{ definitionId: 'worker', name: 'Worker' }]),
        plugins: [channel, scriptedModels],
      },
      modelProfiles: createTestModelProfiles(),
      hostCapabilities: [{
        name: GENERAL_CAPABILITY_NAME, description: 'Test baseline.', uses: [],
        instructions: defineInstructionDocument({ content: '# General' }),
      }],
      petCapabilities: new Map(),
      toolkitInventory: new HostToolkitInventoryStore(),
      checkpoint: new FileSaver(path.join(workdir, 'checkpoints.json')),
      runtimeConfig: buildHostRuntimeConfig(workdir),
      toolAuthorizationMode: 'require_authorization',
      autoAuthorizationSafetyLevel: 'strict',
    });
    const studio = result.studio;
    const subscribe = studio.subscribe;
    let subscribingPet = '';
    const registrations: Array<{ petId: string; filter: StudioEventSubscriptionFilter | undefined }> = [];
    const detachments: Array<typeof registrations[number]> = [];
    const handled: string[] = [];
    studio.subscribe = (handler, filter) => {
      const petId = subscribingPet;
      const registration = { petId, filter };
      registrations.push(registration);
      // Count before bindPetHeadChannel can inspect the payload or ignore it.
      // A broadcast subscription with a consumer-side Channel check fails here.
      const detach = subscribe(async event => {
        const message = event.source === 'channel' && event.type === 'channel.message.created'
          ? event.payload as HeadMessage : undefined;
        if (message) deliveries[petId]!.push(message.body);
        try { await handler(event); }
        finally { if (message) handled.push(message.messageId); }
      }, filter);
      return () => {
        if (petId === 'alpha' && heldSignal) assert.equal(heldSignal.aborted, true, 'Pet aborts before either Head unsubscribe');
        detachments.push(registration);
        detach();
      };
    };
    subscribe(event => {
      if (event.source === 'channel' && event.type === 'channel.message.created') {
        published.push({ topic: event.topic, message: event.payload as HeadMessage });
      }
    });
    const owners: Record<string, string> = {};
    for (const petId of ['alpha', 'beta']) {
      const { channel: { channelId } } = await channel.service.createChannel(human, { title: petId, pets: [] });
      owners[petId] = channelId;
      subscribingPet = petId;
      await studio.pets.create({ petId, definitionId: 'worker', name: petId, channelId });
    }
    assert.equal(registrations.length, 4);
    assert.equal(resolutionCount, 0, 'subscription must not resolve or instantiate an LLM');
    assert.deepEqual(factoryCalls, []);
    for (const petId of ['alpha', 'beta']) {
      assert.deepEqual(registrations.filter(r => r.petId === petId).map(r => r.filter)
        .sort((a, b) => a!.source.localeCompare(b!.source)), [
        { source: 'channel', topic: owners[petId] },
        { source: 'resident-pet', topic: petId },
      ]);
    }
    const { channel: { channelId: emptyChannelId } } = await channel.service.createChannel(human, { title: 'No Pets', pets: [] });
    await channel.service.postMessage(human, owners.alpha!, { body: 'alpha first' });
    await waitFor(() => decisions.alpha!.includes('alpha first'));
    await channel.service.postMessage(human, emptyChannelId, { body: 'no owner here' });
    await channel.service.postMessage(human, owners.beta!, { body: 'beta only' });
    await channel.service.postMessage(human, owners.alpha!, { body: 'alpha second' });
    await waitFor(() => decisions.beta!.includes('beta only') && decisions.alpha!.includes('alpha second'));

    assert.deepEqual(deliveries, { alpha: ['alpha first', 'alpha second'], beta: ['beta only'] },
      'another Channel never enters the Head subscriber wrapper, including Channels with no live Pet');
    assert.deepEqual(decisions, deliveries, 'owner messages continue through the production Head');
    assert.deepEqual(published.map(({ topic, message }) => ({ topic, channelId: message.channelId, body: message.body })), [
      { topic: owners.alpha, channelId: owners.alpha, body: 'alpha first' },
      { topic: emptyChannelId, channelId: emptyChannelId, body: 'no owner here' },
      { topic: owners.beta, channelId: owners.beta, body: 'beta only' },
      { topic: owners.alpha, channelId: owners.alpha, body: 'alpha second' },
    ], 'the real Channel producer labels committed messages and global observers receive each once');

    const ownerChannelId = owners.alpha!;
    const resident = result.residentPets.get('alpha')!;
    const otherDispatch = result.residentPets.get('beta')!.resident.dispatch;
    const otherQueue = otherDispatch.getQueueSnapshot.bind(otherDispatch);
    let otherQueueReads = 0;
    otherDispatch.getQueueSnapshot = () => { otherQueueReads++; return otherQueue(); };
    const admissions: PetDispatchRequest[] = [];
    const sessionReads: string[] = [];
    let activeDispatch: PetDispatchQueueSnapshot['activeDispatch'];
    let switchDuringRead: PetDispatchQueueSnapshot['activeDispatch'];
    let continuingAfterReview = false;
    let reviewPending = false;
    resident.resident.dispatch.getQueueSnapshot = () => ({
      state: activeDispatch || continuingAfterReview ? 'busy' : 'open',
      activeOperation: activeDispatch ? 'dispatch' : null,
      queuedConversations: continuingAfterReview ? 1 : 0, queuedDispatches: Math.max(0, admissions.length - 1),
      ...(activeDispatch ? { activeDispatch } : {}),
    });
    resident.resident.dispatch.dispatch = async request => { admissions.push(request); };
    const recordedPublicTask = 'Verify public reference:  https://example.com/';
    resident.sessions.snapshot = async (sessionId, options) => {
      assert.deepEqual(options, { timelineLimit: 1 });
      sessionReads.push(sessionId);
      if (switchDuringRead) activeDispatch = switchDuringRead;
      return {
        version: 5,
        session: {
          sessionId, kind: 'chat',
          activeRun: activeDispatch || continuingAfterReview ? {
            requestId: continuingAfterReview ? 'resumed-request' : 'opaque-live-request', state: 'running', activity: 'thinking',
          } : null,
          pendingInterrupt: reviewPending ? { interruptId: 'review-pending', payload: { kind: 'human_review', interactions: [] } } : null,
          currentPlan: { items: [
            { id: 'one', capability: 'internal', task: 'Gather inputs.', status: 'completed' },
            { id: 'two', capability: 'internal', task: 'Check the report.', status: 'active' },
            { id: 'three', capability: 'internal', task: 'Verify the figures.', status: 'pending' },
            { id: 'four', capability: 'internal', task: recordedPublicTask, status: 'pending' },
          ] },
          timeline: [
            { type: 'message', id: 'old-text', role: 'assistant', text: 'private checkpoint text', status: 'completed' },
            {
              type: 'operation', id: 'private-tool', requestId: 'opaque-live-request', operationKey: 'private-call',
              kind: 'tool', title: 'Private tool', phase: 'completed', raw: { output: 'private tool output' },
            },
          ],
        },
      };
    };
    const post = async (body: string, replyTo?: string) => (await channel.service.postMessage(human, ownerChannelId, { body, ...(replyTo ? { replyTo } : {}) })).message;
    const replyFor = (id: string) => published.find(item => item.message.replyTo === id)?.message;

    const directQuestion = await post(direct);
    await waitFor(() => !!replyFor(directQuestion.messageId));
    assert.equal(replyFor(directQuestion.messageId)?.body, 'Yes, I am.');
    assert.equal(admissions.length, 0);
    assert.equal(sessionReads.length, 0);
    const sourceA = await post(startA);
    const hasBoundSession = async () => !!(await channel.service.getSession(ownerChannelId, 'alpha'))?.registered;
    await waitFor(() => admissions.length === 1);
    for (let attempts = 0; !(await hasBoundSession()); attempts++) {
      assert.ok(attempts < 100);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(sessionReads.length, 0, 'idle dispatch does not read Session content');
    const a = admissions[0]!;
    assert.equal(a.origin?.id, sourceA.messageId);
    assert.ok(a.dispatchId && a.session && a.scope && a.origin);
    activeDispatch = { dispatchId: a.dispatchId, sessionId: a.session.id, scope: a.scope, origin: a.origin, enqueuedAt: new Date().toISOString() };
    const lifecycle = (type: string, extra: object = {}) => studio.notify({
      source: 'resident-pet', topic: 'alpha', type: `dispatch.${type}`, occurredAt: new Date().toISOString(),
      payload: { invocationId: a.dispatchId, petId: 'alpha', sessionId: a.session!.id, scope: a.scope,
        requestId: 'opaque-live-request', ...extra },
    });
    lifecycle('running');
    const liveSignal = new AbortController().signal;
    assert.equal(await channel.head.readSession(ownerChannelId, 'alpha', 'wrong-session', liveSignal, () => true), undefined);
    await assert.rejects(channel.head.readSession(owners.beta!, 'alpha', a.session.id, liveSignal, () => true), {
      message: `pet:alpha is not a member of Channel "${owners.beta}".`,
    });
    assert.equal(sessionReads.length, 0, 'a foreign Session or Channel must not be read');
    lifecycle('message', { message: { type: 'message.completed', messageId: 'public-a-interim', role: 'assistant', text: interimA } });
    await waitFor(() => published.some(({ message }) => message.externalRef === 'public-a-interim'));
    const elsewhere = await post('Unrelated request for another Pet.');
    const directWhileBusy = await post(direct);
    await waitFor(() => handled.includes(elsewhere.messageId) && !!replyFor(directWhileBusy.messageId));
    assert.equal(replyFor(elsewhere.messageId), undefined, 'declining a message is silent even while A is active');
    assert.equal(replyFor(directWhileBusy.messageId)?.body, 'A is still running.');
    assert.equal(sessionReads.length, 1, 'the relevant busy question samples A; irrelevant text does not');
    assert.equal(admissions.length, 1);
    const check = await post(progress, sourceA.messageId);
    await waitFor(() => !!replyFor(check.messageId));
    assert.equal(replyFor(check.messageId)?.body, 'A is still running.');
    assert.deepEqual(sessionReads, [a.session.id, a.session.id], 'the progress-only turn reads exact busy A only once');
    assert.equal(admissions.length, 1, 'progress-only turns never dispatch');
    const both = await post(mixed, sourceA.messageId);
    await waitFor(() => admissions.length === 1 && !!replyFor(both.messageId));
    assert.equal(replyFor(both.messageId)?.body, 'A is still running.');
    assert.deepEqual(sessionReads, [a.session.id, a.session.id, a.session.id], 'mixed asks still sample only A once each');
    assert.deepEqual(canonicalDecisions.map(input => input.message.messageId), [directQuestion.messageId]);
    assert.equal(composeInputs.length, 0);
    assert.equal(resolutionCount, 2, 'each active Head resolves only one client');
    assert.equal(factoryCalls.length, 2);
    const alphaClient = decisionClients.find(turn => turn.body === startA)!.client;
    assert.deepEqual(runningCalls, [directWhileBusy, check, both].map(({ messageId }) => ({
      messageId, client: alphaClient,
      execution: { status: 'running', plan: [
        { status: 'completed', description: 'Gather inputs.' },
        { status: 'active', description: 'Check the report.' },
        { status: 'pending', description: 'Verify the figures.' },
        { status: 'pending', description: recordedPublicTask },
      ], result: { body: interimA }, source: { messageId: sourceA.messageId, body: sourceA.body }, mayInterrupt: true },
    })));
    assert.equal(otherQueueReads, 0, 'alpha Head samples only its own dispatch port');
    assert.equal(admissions.length, 1, 'busy mixed question cannot admit new work');
    assert.equal(activeDispatch.dispatchId, a.dispatchId);
    const activeA = activeDispatch;
    const activeB = { ...activeA, dispatchId: 'synthetic-other-dispatch', origin: { namespace: 'channel', id: both.messageId } };
    const realReply = channel.head.reply;
    let staleAtWrite = false;
    channel.head.reply = async (...args) => {
      staleAtWrite = true;
      activeDispatch = activeB;
      await realReply(...args);
    };
    try {
      const raceAtWrite = await post(progress, sourceA.messageId);
      const fence = (await post('alpha write fence')).body;
      await waitFor(() => decisions.alpha!.includes(fence));
      assert.equal(staleAtWrite, true);
      assert.equal(replyFor(raceAtWrite.messageId), undefined, 'a stale result cannot be committed after the run changes');
      assert.equal(admissions.length, 1);
    } finally {
      channel.head.reply = realReply;
      activeDispatch = activeA;
    }
    switchDuringRead = activeB;
    const race = await post(progress, sourceA.messageId);
    await waitFor(() => !!replyFor(race.messageId));
    assert.equal(replyFor(race.messageId)?.body, 'I cannot verify the current status.');
    assert.deepEqual(sessionReads, [a.session.id, a.session.id, a.session.id, a.session.id, a.session.id], 'each race reads once and never retries on B');
    assert.deepEqual((composeInputs.at(-1) as { evidence: unknown }).evidence, { status: 'unavailable' });
    assert.equal(admissions.length, 1);

    switchDuringRead = undefined;
    reviewPending = true;
    activeDispatch = activeA;
    const duringReview = await post(progress, sourceA.messageId);
    await waitFor(() => !!replyFor(duringReview.messageId));
    assert.equal(replyFor(duringReview.messageId)?.body, 'Waiting for review.');
    assert.deepEqual(composeInputs.at(-1)?.evidence, { status: 'waiting' },
      'pending review may not expose the recorded plan');
    assert.equal(admissions.length, 1);

    // A resumed review emits dispatch.running, but executes as a conversation
    // hold and does not occupy the ordinary dispatch queue slot.
    reviewPending = false;
    const readsBeforeApproval = sessionReads.length;
    lifecycle('waiting');
    activeDispatch = undefined;
    continuingAfterReview = true;
    lifecycle('running', { requestId: 'resumed-request' });
    const approvalFollowup = await post(progress, sourceA.messageId);
    await waitFor(() => !!replyFor(approvalFollowup.messageId));
    assert.equal(replyFor(approvalFollowup.messageId)?.body, 'I cannot verify the current status.');
    assert.equal(sessionReads.length, readsBeforeApproval + 1, 'the bound Session is sampled, but continuation is outside the ordinary dispatch slot');
    assert.deepEqual(composeInputs.at(-1)?.evidence, { status: 'unavailable' });
    assert.equal(admissions.length, 1);

    const beforeOfficial = decisions.alpha!.length;
    lifecycle('message', { requestId: 'resumed-request', message: { type: 'message.completed', messageId: 'public-a', role: 'assistant', text: finalA } });
    lifecycle('completed', { requestId: 'resumed-request', reply: finalA });
    continuingAfterReview = false;
    await waitFor(() => published.some(({ message }) => message.externalRef === 'public-a'));
    const fence = (await post('alpha fence')).body;
    await waitFor(() => decisions.alpha!.includes(fence));
    assert.equal(decisions.alpha!.length, beforeOfficial + 1, 'resident events or own output must not start another judgment');
    assert.equal(published.filter(({ message }) => message.body === finalA).length, 1, 'official result uses only the existing Channel bridge');
    assert.equal(admissions.length, 1);

    const oldRegistrations = registrations.filter(entry => entry.petId === 'alpha');
    const realClose = resident.close.bind(resident);
    let closed = false;
    resident.close = async () => {
      assert.equal(detachments.length, 2, 'each owned topic detaches exactly once');
      assert.deepEqual(new Set(detachments), new Set(oldRegistrations), 'both alpha topics detach before its runtime stops; beta stays active');
      assert.equal(heldSignal?.aborted, true);
      await realClose();
      closed = true;
    };
    activeDispatch = undefined;
    const late = await post(held);
    await waitFor(() => heldSignal !== undefined);
    await post('queued before alpha closes');
    await studio.pets.closeInstance('alpha', { confirmStop: true });
    assert.equal(closed, true);
    await post('sent while alpha is closed');
    const betaAlive = (await channel.service.postMessage(human, owners.beta!, { body: 'beta remains online' })).message;
    await waitFor(() => handled.includes(betaAlive.messageId));
    subscribingPet = 'alpha';
    await studio.pets.reopenInstance('alpha');
    assert.equal(factoryCalls.length, 2, 'reopening still defers client construction');
    // If the old Head incorrectly dispatches into the new activation, capture
    // it locally rather than allowing the resident to call a real endpoint.
    result.residentPets.get('alpha')!.resident.dispatch.dispatch = async request => { admissions.push(request); };
    const newRegistrations = registrations.filter(entry => entry.petId === 'alpha').slice(2);
    assert.equal(newRegistrations.length, 2, 'reopening establishes just one fresh subscription pair');
    assert.deepEqual(newRegistrations.map(entry => entry.filter).sort((a, b) => a!.source.localeCompare(b!.source)), [
      { source: 'channel', topic: ownerChannelId },
      { source: 'resident-pet', topic: 'alpha' },
    ]);
    const testReopened = await post('alpha receives live traffic after reopen');
    await waitFor(() => handled.includes(testReopened.messageId));
    assert.equal(factoryCalls.length, 3);
    assert.equal(resolutionCount, 3);
    assert.notEqual(decisionClients.at(-1)?.client, alphaClient, 'a new activation builds its own client');
    releaseHeld();
    await waitFor(() => handled.includes(late.messageId));
    assert.equal(admissions.length, 1, 'the canceled decision never dispatches');
    assert.equal(replyFor(late.messageId), undefined, 'the canceled decision never publishes');
    for (const offline of ['queued before alpha closes', 'sent while alpha is closed']) {
      assert.ok(!decisions.alpha!.includes(offline), 'no replay into the reopened Head');
      assert.ok(!deliveries.alpha!.includes(offline), 'closed subscription does not receive offline input');
    }
  } finally {
    releaseHeld();
    await result?.studio.shutdown();
    await rm(workdir, { recursive: true, force: true });
  }
});
