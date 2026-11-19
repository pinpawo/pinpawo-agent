import assert from 'node:assert/strict';
import test from 'node:test';
import type { Studio, StudioDispatchReceipt, StudioEvent, StudioEventHandler } from '../studioContract';
import { observePetHeadDispatches, type HeadDispatchObservation } from './petHeadDispatch';

const pet = { petId: 'worker-1', channelId: 'team', definitionId: 'worker', name: 'Worker 1', createdAt: '2026-01-01T00:00:00Z' };
let nextEventId = 0;
const event = (type: string, invocationId: string, payload: Record<string, unknown> = {}, occurredAt = pet.createdAt): StudioEvent => ({
  eventId: `event-${nextEventId++}`, occurredAt, type, source: 'resident-pet', topic: pet.petId,
  payload: {
    petId: pet.petId, scope: { namespace: 'channel', id: 'team' }, invocationId, sessionId: 'channel-session',
    ...(type !== 'dispatch.queued' ? { requestId: 'host-first' } : {}), ...payload,
  },
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const controller = new AbortController();
  let deliver!: StudioEventHandler;
  let unsubscribed = 0;
  const seen: HeadDispatchObservation[] = [];
  const subscribe: Studio['subscribe'] = (handler, filter) => {
    assert.deepEqual(filter, { source: 'resident-pet', topic: pet.petId });
    deliver = handler;
    return () => { unsubscribed++; };
  };
  const observation = observePetHeadDispatches(pet, subscribe, controller.signal, value => seen.push(value));
  return { controller, observation, seen, deliver, get unsubscribed() { return unsubscribed; } };
}

test('Head correlates only its admitted invocation and treats Agent messages separately from lifecycle', async () => {
  const f = fixture();
  const invocationId = 'studio-invocation';
  const sourceMessageId = 'channel-source';
  const admission = deferred<StudioDispatchReceipt>();
  f.observation.track(sourceMessageId, { invocationId, receipt: admission.promise });
  f.deliver(event('dispatch.queued', invocationId));
  f.deliver(event('dispatch.running', 'trigger-invocation', { requestId: invocationId }));
  f.deliver(event('dispatch.failed', invocationId, { petId: 'other' }));
  f.deliver(event('dispatch.completed', invocationId, { scope: { namespace: 'channel', id: 'elsewhere' } }));
  f.deliver(event('dispatch.completed', invocationId, { scope: { namespace: 'scheduler', id: 'team' } }));
  f.deliver({ ...event('dispatch.completed', invocationId), topic: 'other' });
  f.deliver({ ...event('dispatch.accepted', invocationId), source: 'studio', topic: undefined });
  f.deliver(event('dispatch.accepted', invocationId));
  assert.equal(f.seen.length, 0, 'allocated identity and early events are not yet confirmed');

  admission.resolve({ invocationId, petId: pet.petId });
  await admission.promise;
  f.deliver(event('dispatch.running', invocationId, { requestId: 'host-first' }));
  f.deliver(event('dispatch.waiting', invocationId, { requestId: 'host-first' }));
  f.deliver(event('dispatch.running', invocationId, { requestId: 'host-resume' }));
  f.deliver(event('dispatch.message', invocationId, { requestId: 'host-resume', message: { type: 'message.completed', role: 'assistant', messageId: 'agent-reply', text: 'ignored here' } }));
  f.deliver(event('dispatch.completed', invocationId, { requestId: 'host-resume' }));
  f.deliver(event('dispatch.failed', invocationId, { requestId: 'host-resume' }));
  assert.deepEqual(f.seen.map(({ invocationId: actual, sourceMessageId: source, ...observation }) => {
    assert.equal(actual, invocationId);
    assert.equal(source, sourceMessageId);
    return observation;
  }), [
    { kind: 'lifecycle', phase: 'queued' },
    { kind: 'lifecycle', phase: 'running' },
    { kind: 'lifecycle', phase: 'waiting' },
    { kind: 'lifecycle', phase: 'running' },
    { kind: 'agent-message', agentMessageId: 'agent-reply' },
    { kind: 'lifecycle', phase: 'completed' },
  ]);
  assert.equal(f.observation.byId(invocationId)?.phase, 'completed');
  assert.deepEqual(f.observation.source(sourceMessageId).map(record => record.agentMessageIds), [['agent-reply']]);
  assert.deepEqual(f.observation.ongoing(), { records: [], incomplete: false });
  f.observation.unsubscribe();
});

test('rejected and mismatched admission, abort, and unsubscribe drop observations and late delivery', async () => {
  const f = fixture();
  const rejected = deferred<StudioDispatchReceipt>();
  const mismatched = deferred<StudioDispatchReceipt>();
  const pending = deferred<StudioDispatchReceipt>();
  for (const [invocationId, admission] of [['reject', rejected], ['mismatch', mismatched], ['pending', pending]] as const) {
    f.observation.track('source', { invocationId, receipt: admission.promise });
    f.deliver(event('dispatch.queued', invocationId));
  }
  rejected.reject(new Error('not admitted'));
  mismatched.resolve({ invocationId: 'different', petId: pet.petId });
  await Promise.allSettled([rejected.promise, mismatched.promise]);
  f.deliver(event('dispatch.completed', 'reject'));
  f.deliver(event('dispatch.completed', 'mismatch'));
  f.controller.abort();
  pending.resolve({ invocationId: 'pending', petId: pet.petId });
  await pending.promise;
  f.observation.unsubscribe();
  f.observation.unsubscribe();
  f.deliver(event('dispatch.completed', 'pending'));
  assert.equal(f.unsubscribed, 1);
  assert.deepEqual(f.seen, []);
  assert.deepEqual(f.observation.source('source'), []);
  assert.equal(f.observation.byId('reject'), undefined);
});

async function admit(f: ReturnType<typeof fixture>, invocationId: string, sourceMessageId = invocationId) {
  const receipt = Promise.resolve({ invocationId, petId: pet.petId });
  f.observation.track(sourceMessageId, { invocationId, receipt });
  await receipt;
}

test('phase timestamps reflect fresh evidence, not duplicate or regressive notices', async () => {
  const f = fixture();
  await admit(f, 'run');
  const original = event('dispatch.running', 'run', {}, '2026-01-01T00:01:00Z');
  f.deliver(original);
  f.deliver({ ...original, occurredAt: '2026-01-01T00:02:00Z' });
  f.deliver(event('dispatch.running', 'run', {}, '2026-01-01T00:03:00Z'));
  f.deliver(event('dispatch.queued', 'run', {}, '2026-01-01T00:04:00Z'));
  f.deliver(event('dispatch.waiting', 'run', { sessionId: 'wrong-session' }, '2026-01-01T00:05:00Z'));
  assert.equal(f.observation.byId('run')?.observedAt, original.occurredAt);
  assert.deepEqual(f.seen.map(e => e.kind === 'lifecycle' && e.phase), ['running']);

  // Studio's ordered subscription defines event delivery; timestamps do not re-order phases.
  const waiting = event('dispatch.waiting', 'run', {}, '2026-01-01T00:00:00Z');
  f.deliver(waiting);
  assert.equal(f.observation.byId('run')?.phase, 'waiting');
  assert.equal(f.observation.byId('run')?.observedAt, waiting.occurredAt);
});

test('waiting is generic unless typed as human review; continuation rejects the old attempt and keeps only its own assistant outputs', async () => {
  const f = fixture();
  await admit(f, 'run');
  f.deliver(event('dispatch.running', 'run'));
  f.deliver(event('dispatch.waiting', 'run', {
    pendingInterrupt: { interruptId: 'interrupt-first', payload: { kind: 'something_else', label: 'human_review' } },
  }));
  assert.equal(f.observation.byId('run')?.humanReview, false);

  const review = event('dispatch.waiting', 'run', {
    pendingInterrupt: { interruptId: 'interrupt-first', payload: { kind: 'human_review' } },
  }, '2026-01-01T00:01:00Z');
  f.deliver(review);
  f.deliver(event('dispatch.waiting', 'run', {}, '2026-01-01T00:02:00Z'));
  f.deliver(event('dispatch.waiting', 'run', {
    pendingInterrupt: { interruptId: 'interrupt-first', payload: { kind: 'something_else' } },
  }, '2026-01-01T00:03:00Z'));
  assert.equal(f.observation.byId('run')?.humanReview, true);
  assert.equal(f.observation.byId('run')?.interruptId, 'interrupt-first');
  assert.equal(f.observation.byId('run')?.observedAt, review.occurredAt);

  const emitOutput = (id: string, requestId = 'host-first', role = 'assistant') => f.deliver(event('dispatch.message', 'run', {
    requestId, message: { type: 'message.completed', role, messageId: id, text: 'private message text' },
  }));
  emitOutput('initial-output');
  f.deliver(event('dispatch.running', 'run', { requestId: 'host-next', sessionId: 'wrong-session' }));
  assert.equal(f.observation.byId('run')?.phase, 'waiting');
  f.deliver(event('dispatch.running', 'run', { requestId: 'host-next' }));
  f.deliver(event('dispatch.running', 'run', { requestId: 'host-first' }));
  f.deliver(event('dispatch.failed', 'run'));
  emitOutput('late-old-output');
  emitOutput('head-reply:reserved', 'host-next');
  emitOutput('not-assistant', 'host-next', 'user');
  emitOutput('new-output', 'host-next');

  const current = f.observation.byId('run');
  assert.equal(current?.requestId, 'host-next');
  assert.equal(current?.phase, 'running');
  assert.equal(current?.humanReview, false);
  assert.equal(current?.interruptId, undefined);
  assert.deepEqual(current?.agentMessageIds, ['new-output']);
  assert.doesNotMatch(JSON.stringify(current), /private message text/);
});

test('early evidence, per-attempt output references, and active ownership are bounded', async () => {
  const f = fixture();
  const admission = deferred<StudioDispatchReceipt>();
  f.observation.track('first-message', { invocationId: 'first', receipt: admission.promise });
  for (let n = 0; n < 17; n++) f.deliver(event('dispatch.queued', 'first'));
  assert.equal(f.observation.byId('first'), undefined);
  assert.equal(f.observation.ongoing().incomplete, true);
  admission.resolve({ invocationId: 'first', petId: pet.petId });
  await admission.promise;

  assert.equal(f.observation.byId('first')?.incomplete, true);
  assert.equal(f.observation.byId('first')?.phase, 'queued');
  f.deliver(event('dispatch.running', 'first'));
  assert.equal(f.observation.byId('first')?.incomplete, false);

  for (let n = 0; n < 10; n++) f.deliver(event('dispatch.message', 'first', {
    message: { type: 'message.completed', role: 'assistant', messageId: `output-${n}` },
  }));
  assert.deepEqual(f.observation.byId('first')?.agentMessageIds, Array.from({ length: 8 }, (_, n) => `output-${n + 2}`));

  for (let n = 1; n < 32; n++) await admit(f, `live-${n}`);
  assert.equal(f.observation.ongoing().records.length, 32);
  const rejected = deferred<StudioDispatchReceipt>();
  f.observation.track('not-admitted', { invocationId: 'not-admitted', receipt: rejected.promise });
  assert.equal(f.observation.ongoing().incomplete, true);
  rejected.reject(Error('synthetic rejection'));
  await Promise.allSettled([rejected.promise]);
  assert.equal(f.observation.ongoing().incomplete, false);
  await admit(f, 'overflow');
  f.deliver(event('dispatch.running', 'overflow'));
  assert.equal(f.observation.ongoing().records.length, 32);
  assert.equal(f.observation.ongoing().incomplete, true);
  assert.equal(f.observation.byId('overflow'), undefined);

  f.deliver(event('dispatch.completed', 'first'));
  assert.equal(f.observation.ongoing().records.length, 31);
  assert.equal(f.observation.ongoing().incomplete, true);
  assert.equal(f.observation.source('first-message')[0]?.phase, 'completed');
});

test('terminal retention is bounded, terminal state is immutable, and a reopened observer cannot reclaim old events', async () => {
  const f = fixture();
  for (let n = 0; n < 33; n++) {
    const id = `invocation-${n}`;
    await admit(f, id);
    f.deliver(event('dispatch.completed', id));
    f.deliver(event('dispatch.failed', id));
  }
  assert.equal(f.observation.byId('invocation-0'), undefined);
  assert.equal(f.observation.byId('invocation-1')?.phase, 'completed');
  assert.equal(f.observation.byId('invocation-32')?.phase, 'completed');
  assert.equal(f.seen.length, 33);

  f.observation.unsubscribe();
  const reopened = fixture();
  reopened.deliver(event('dispatch.running', 'invocation-32'));
  reopened.deliver(event('dispatch.completed', 'invocation-32'));
  assert.deepEqual(reopened.seen, []);
  assert.equal(reopened.observation.byId('invocation-32'), undefined);
});
