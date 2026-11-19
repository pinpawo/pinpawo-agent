import assert from 'node:assert/strict';
import test from 'node:test';
import type { PetDispatchLifecycleEvent, PetDispatchPort, PetSessionPort } from 'pinpawo/host-runtime';
import { STUDIO_HEAD_PROGRESS_REPLY } from '../../../packages/studio/src/studioContract';
import { prepareStudio } from '../../../packages/studio/src/createStudio';
import { bindPetHeadChannel, subscribePetHead } from '../../../packages/studio/src/host/petHead';
import type { HeadDispatchObservation } from '../../../packages/studio/src/host/petHeadDispatch';
import { createChannelPlugin } from '../../../plugins/channel/src/channelPlugin';
import type { ChannelMessage } from '../../../plugins/channel/src/channelService';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const human = { kind: 'human' as const, id: 'local' };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('the owning Head answers from resident evidence without dispatch or assuming Timeline delivery', { timeout: 10_000 }, async (t) => {
  const channel = createChannelPlugin({ httpRoute: false });
  const seen: HeadDispatchObservation[] = [];
  const admittedHead = deferred<void>();
  const allowAdmission = deferred<void>();
  const allowCommit = deferred<void>();
  const confirmFailed = deferred<void>();
  const writerEntered = deferred<void>();
  const running = deferred<void>();
  const completed = deferred<void>();
  const enteredHead = deferred<{
    invocationId: string;
    emit: (event: Omit<PetDispatchLifecycleEvent, 'dispatchId' | 'request' | 'sessionId' | 'scope'>) => void;
  }>();
  const committed = deferred<ChannelMessage>();
  let headAdmissions = 0;
  const sessionReads: Array<{ petId: string; sessionId: string; limit?: number }> = [];
  const decisionInputs: Array<{ petId: string; messageId: string }> = [];
  const passedFence = new Set<string>();
  const bothHeadsPastFence = deferred<void>();
  const progressReplies = new Map<string, ReturnType<typeof deferred<ChannelMessage>>>();
  const prepared = prepareStudio({
    studioId: 'head-dispatch-notifications', definitions: [{ definitionId: 'definition', name: 'Worker' }], plugins: [channel],
    assemblePet: async ({ petId }) => {
      let listener: Parameters<PetDispatchPort['onDispatchLifecycle']>[0] | undefined;
      return {
        dispatch: {
          getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
          onQueueChange: () => () => {},
          onDispatchLifecycle: next => { listener = next; return () => { listener = undefined; }; },
          dispatch: async ({ dispatchId, session, scope, origin, request }) => {
            assert.ok(dispatchId && session && scope);
            const emit = (event: Omit<PetDispatchLifecycleEvent, 'dispatchId' | 'request' | 'sessionId' | 'scope'>) =>
              listener?.({ ...event, dispatchId, request, sessionId: session.id, scope });
            emit({ state: 'queued' });
            if (origin) {
              headAdmissions++;
              enteredHead.resolve({ invocationId: dispatchId, emit });
              await allowAdmission.promise;
            } else {
              emit({ state: 'running', requestId: 'separate-run' });
              emit({ state: 'completed', requestId: 'separate-run' });
            }
          },
        },
        sessions: {
          snapshot: async (sessionId, options) => {
            sessionReads.push({ petId, sessionId, limit: options?.timelineLimit });
            return {
              version: 5,
              session: {
                sessionId, kind: 'chat',
                activeRun: { requestId: 'host-1', state: 'running', activity: 'thinking' },
                pendingInterrupt: null,
                // The snapshot's checkpoint plan need not belong to this active run.
                currentPlan: { items: [{ id: 'stale', capability: 'not-current', task: 'Unattributed plan text', status: 'active' }] },
                timeline: [{ id: 'past', type: 'message', role: 'assistant', text: 'Private checkpoint text', status: 'completed' }],
              },
            };
          },
          observe: async () => { throw new Error('A progress question must not subscribe to an Agent Session'); },
          review: async () => { throw new Error('A progress question must not respond to an Agent Session review'); },
        } satisfies PetSessionPort,
        close: async () => {},
      };
    },
    subscribePetTimeline: ({ registration }, signal) => subscribePetHead({
      pet: registration,
      channel: bindPetHeadChannel(registration.channelId, channel.head, prepared.studio.subscribe),
      decide: async (input) => {
        const { message, pet } = input;
        assert.doesNotMatch(JSON.stringify(input), /Unattributed plan text|Private checkpoint text/);
        decisionInputs.push({ petId: pet.petId, messageId: message.messageId });
        if (message.body === 'Head subscription fence') {
          passedFence.add(pet.petId);
          if (passedFence.size === 2) bothHeadsPastFence.resolve();
        }
        if (pet.petId === 'worker-1' && message.body === 'work') {
          return { action: 'dispatch', timing: 'enqueue', reply: 'I’ll look into it.', intent: 'Do the work.' };
        }
        if (message.body.startsWith('Progress?')) {
          // Deliberately choose this for both Heads. The runtime must validate the target.
          const action = message.body.includes('exact step') ? 'progress-details'
            : message.body.includes('and rerun') ? 'progress-mixed' : 'progress-status';
          return { action, timing: 'enqueue', reply: '', intent: '' };
        }
        return { action: 'ignore', timing: 'enqueue', reply: '', intent: '' };
      },
      onDispatchObservation: event => {
        seen.push(event);
        if (event.kind !== 'lifecycle') return;
        if (event.phase === 'queued') admittedHead.resolve();
        if (event.phase === 'running') running.resolve();
        if (event.phase === 'completed') completed.resolve();
      },
    }, prepared.studio.subscribe, signal),
  });
  const studio = prepared.studio;
  t.after(async () => {
    allowAdmission.resolve();
    allowCommit.resolve();
    await studio.shutdown();
  });
  await prepared.activatePlugins();
  const { channel: { channelId } } = await channel.service.createChannel(human, { title: 'Notifications', pets: [] });
  for (const petId of ['worker-1', 'worker-2']) {
    await studio.pets.create({ petId, channelId, definitionId: 'definition', name: petId });
  }

  const { message: source } = await channel.service.postMessage(human, channelId, { body: 'work' });
  const head = await enteredHead.promise;
  const outside = await channel.run(channelId, 'worker-1', 'independent trigger', { kind: 'trigger', id: 'trigger-1' });
  assert.notEqual(outside.invocationId, head.invocationId);
  await tick();
  assert.equal(seen.length, 0, 'nothing is attributed before admission despite early resident events');

  const service = channel.service;
  const confirmSession = service.confirmSession.bind(service);
  service.confirmSession = async binding => {
    service.confirmSession = confirmSession;
    await confirmSession(binding);
    confirmFailed.resolve();
    throw new Error('synthetic failure after Studio admission');
  };
  allowAdmission.resolve();
  await admittedHead.promise;
  await confirmFailed.promise;
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    invocationId: head.invocationId, sourceMessageId: source.messageId, kind: 'lifecycle', phase: 'queued',
  }, 'the early notification survived, but admission is not execution completion');

  const postMessage = service.postMessage.bind(service);
  service.postMessage = async (...args) => {
    if (args[3]?.externalRef === 'agent-reply') {
      writerEntered.resolve();
      await allowCommit.promise;
    }
    return postMessage(...args);
  };
  studio.subscribe(event => {
    const message = event.payload as ChannelMessage;
    if (event.type !== 'channel.message.created') return;
    if (message.externalRef === 'agent-reply') committed.resolve(message);
    if (event[STUDIO_HEAD_PROGRESS_REPLY] && message.replyTo) {
      assert.equal(JSON.parse(JSON.stringify(event)).metadata, undefined);
      let reply = progressReplies.get(message.replyTo);
      if (!reply) progressReplies.set(message.replyTo, reply = deferred<ChannelMessage>());
      reply.resolve(message);
    }
  }, { source: 'channel', topic: channelId });

  const timeline = () => service.readContext(human, channelId, { limit: 50 });
  const ask = async (body: string, replyTo: string, mentions: Array<{ participantId: string }> = []) => {
    const { message: question } = await service.postMessage(human, channelId, { body: `Progress? ${body}`, replyTo, mentions });
    let reply = progressReplies.get(question.messageId);
    if (!reply) progressReplies.set(question.messageId, reply = deferred<ChannelMessage>());
    const status = await reply.promise;
    assert.deepEqual(status.author, { kind: 'pet', id: 'worker-1' });
    assert.equal(status.replyTo, question.messageId);
    assert.deepEqual(status.mentions, []);
    assert.doesNotMatch(status.body, /host-1|agent-reply/);
    return { question, status };
  };

  head.emit({ state: 'running', requestId: 'host-1' });
  await running.promise;
  const ack = (await timeline()).messages.find(message => message.externalRef === `head-reply:${source.messageId}`);
  assert.ok(ack);
  const midway = await ask('midway', ack.messageId); // Pet author targets Worker 1; one hop selects its source.
  assert.match(midway.status.body, /running/i);
  assert.equal(headAdmissions, 1);
  assert.equal(sessionReads.length, 0, 'fresh status uses observed lifecycle facts');
  const chained = await ask('replying to a prior progress response', midway.status.messageId);
  assert.doesNotMatch(chained.status.body, /running|queued|completed/i, 'a progress answer cannot be chained back to dispatch');
  const mixed = await ask('and rerun this?', ack.messageId);
  assert.match(mixed.status.body, /separate|separately/i);
  assert.equal(headAdmissions, 1, 'a mixed question cannot start another execution');
  const details = await ask('which exact step?', ack.messageId);
  assert.match(details.status.body, /running/i);
  assert.doesNotMatch(details.status.body, /Unattributed plan text|not-current|Private checkpoint text/);
  const binding = await service.getSession(channelId, 'worker-1');
  assert.ok(binding);
  assert.deepEqual(sessionReads.map(({ petId, sessionId }) => ({ petId, sessionId })), [
    { petId: 'worker-1', sessionId: binding.sessionId },
  ]);
  assert.ok((sessionReads[0]?.limit ?? Infinity) <= 16, 'read a bounded window just once for a detailed question');
  const worker = [{ participantId: 'pet:worker-1' }];
  const unrelated = (await service.postMessage(human, channelId, { body: 'Unrelated human message' })).message;
  const invalid = await ask('invalid reference', unrelated.messageId, worker);
  assert.doesNotMatch(invalid.status.body, /running|queued|completed/i, 'an unowned explicit reference must not fall back to the active run');
  // Re-deliver the exact committed question. The Channel must not deliver a second status reply.
  studio.notify({
    type: 'channel.message.created', source: 'channel', topic: channelId,
    occurredAt: midway.question.occurredAt, payload: midway.question,
  });

  head.emit({ state: 'message', requestId: 'host-1', message: {
    type: 'message.completed', messageId: 'agent-reply', role: 'assistant', text: 'Partial result: the execution limit was reached.',
  } });
  head.emit({ state: 'completed', requestId: 'host-1' });
  await writerEntered.promise;
  await completed.promise;
  const notDelivered = await ask('before projection commits', source.messageId, worker);
  assert.match(notDelivered.status.body, /ended|finished|completed/i);
  assert.match(notDelivered.status.body, /cannot confirm|not confirmed|could not confirm|haven.t confirmed|hasn.t been confirmed|unconfirmed/i);
  assert.ok(!(await timeline()).messages.some(message => message.externalRef === 'agent-reply'));
  for (const { question, status } of [midway, chained, mixed, details, invalid, notDelivered]) {
    assert.equal((await timeline()).messages.filter(message => message.externalRef === `head-reply:${question.messageId}`).length, 1);
    assert.ok(!decisionInputs.some(input => input.messageId === status.messageId), 'status replies must not fan out to the second Head');
  }
  assert.deepEqual(seen.slice(1).map(({ invocationId, sourceMessageId, ...event }) => {
    assert.equal(invocationId, head.invocationId);
    assert.equal(sourceMessageId, source.messageId);
    return event;
  }), [
    { kind: 'lifecycle', phase: 'running' },
    { kind: 'agent-message', agentMessageId: 'agent-reply' },
    { kind: 'lifecycle', phase: 'completed' },
  ]);

  allowCommit.resolve();
  const output = await committed.promise;
  assert.match(output.body, /Partial result/);
  const delivered = await ask('after projection commits', source.messageId, worker);
  assert.match(delivered.status.body, /ended|finished|completed/i);
  assert.match(delivered.status.body, /(?:reply|response).*(?:was posted in|was published in|is in) (?:this|the) Channel/i);
  assert.doesNotMatch(delivered.status.body, /successful|succeeded|all deliverables/i);

  const ambiguous = (await service.postMessage(human, channelId, { body: 'Progress? two Pets' })).message;
  const conflicting = (await service.postMessage(human, channelId, {
    body: 'Progress? conflicting targets', replyTo: ack.messageId, mentions: [{ participantId: 'pet:worker-2' }],
  })).message;
  await service.postMessage(human, channelId, { body: 'Head subscription fence' });
  await bothHeadsPastFence.promise;
  assert.ok(!(await timeline()).messages.some(message =>
    message.replyTo === ambiguous.messageId || message.replyTo === conflicting.messageId),
  'ambiguous or conflicting targets cannot produce a reply');
  assert.ok(!decisionInputs.some(input => input.messageId === delivered.status.messageId));
  await studio.pets.closeInstance('worker-1', { confirmStop: true });
  await studio.pets.reopenInstance('worker-1');
  const replayed = deferred<void>();
  const dispatch = channel.head.dispatch;
  channel.head.dispatch = async (...args) => {
    await dispatch(...args);
    replayed.resolve();
  };
  studio.notify({ type: 'channel.message.created', source: 'channel', topic: channelId, occurredAt: source.occurredAt, payload: source });
  await replayed.promise;
  studio.notify({
    type: 'dispatch.failed', source: 'resident-pet', topic: 'worker-1', occurredAt: source.occurredAt,
    payload: { invocationId: head.invocationId, petId: 'worker-1', scope: { namespace: 'channel', id: channelId } },
  });
  await tick();
  assert.equal(headAdmissions, 1, 'replaying the source reuses admission and does not start or reclaim work');
  assert.equal(seen.length, 4);
  const reopened = await ask('after reopen', source.messageId, worker);
  assert.doesNotMatch(reopened.status.body, /running|queued|completed/i, 'an old source cannot reacquire ownership');
  assert.equal(headAdmissions, 1, 'intermediate and repeated questions are read-only');
});
