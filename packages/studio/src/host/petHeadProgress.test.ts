import assert from 'node:assert/strict';
import test from 'node:test';
import type { StudioEvent, StudioEventHandler, StudioEventSubscriptionFilter, StudioPetSessions } from '../studioContract';
import type { HeadMessage } from './petHead';
import { observeHeadRun, readHeadProgress } from './petHeadProgress';

const active = { dispatchId: 'dispatch-a', sessionId: 'shared-session', messageId: 'question-a' };
const run = { invocationId: active.dispatchId, sessionId: active.sessionId, requestId: 'run-a', publishedIds: ['public', 'not-on-channel', 'fake-role'] };
const signal = new AbortController().signal;

function event(type: string, overrides: Record<string, unknown> = {}): StudioEvent {
  return { type: `dispatch.${type}`, eventId: type, source: 'resident-pet', topic: 'pet-a', occurredAt: '2026-11-20T01:01:00Z',
    payload: { petId: 'pet-a', invocationId: active.dispatchId, sessionId: active.sessionId, requestId: run.requestId,
      scope: { namespace: 'channel', id: 'team' }, request: 'raw original request', ...overrides } };
}
test('Head observes only its instance topic and exact scope, with no payload retention or replay', async () => {
  let listener: StudioEventHandler | undefined;
  let filter: StudioEventSubscriptionFilter | undefined;
  const observation = observeHeadRun((handler, selected) => {
    listener = handler; filter = selected; return () => { listener = undefined; };
  }, 'pet-a', 'team', signal);
  assert.deepEqual(filter, { source: 'resident-pet', topic: 'pet-a' });
  await listener?.({ ...event('running'), topic: 'other' });
  await listener?.({ ...event('running'), source: 'channel' });
  await listener?.(event('running', { petId: 'other' }));
  await listener?.(event('running', { scope: { namespace: 'channel', id: 'other' } }));
  await listener?.(event('queued'));
  assert.equal(observation.read(active), undefined);
  await listener?.(event('running'));
  assert.deepEqual(observation.read(active), { ...run, publishedIds: [] });
  assert.equal(observation.read({ ...active, sessionId: 'other' }), undefined);
  await listener?.(event('message', { message: { type: 'message.completed', messageId: 'public', text: 'do not retain event text' } }));
  await listener?.(event('message', { message: { type: 'message.completed', messageId: 'public', text: 'duplicate' } }));
  await listener?.(event('message', { requestId: 'other-run', message: { type: 'message.completed', messageId: 'other' } }));
  await listener?.(event('completed', { requestId: 'old' }));
  assert.deepEqual(observation.read(active), { ...run, publishedIds: ['public'] });
  await listener?.(event('completed', { reply: 'never republish' }));
  assert.equal(observation.read(active), undefined);
  await listener?.(event('running'));
  observation.close();
  assert.equal(listener, undefined);
  assert.equal(observation.read(active), undefined);
});

type Snapshot = Awaited<ReturnType<StudioPetSessions['snapshot']>>;
function snapshot(requestId = 'run-a'): Snapshot {
  return { session: { sessionId: 'shared-session', activeRun: { requestId, state: 'running', activity: 'using_tool' },
    currentPlan: { items: [{ task: 'private child plan' }] }, pendingInterrupt: { payload: 'private approval' }, timeline: [
      { type: 'operation', raw: { result: 'private tool result' } },
      { type: 'message', id: 'private', role: 'assistant', status: 'completed', text: 'private TUI text' },
      { type: 'message', id: 'not-on-channel', role: 'assistant', status: 'completed', text: 'uncommitted update' },
      { type: 'message', id: 'fake-role', role: 'user', status: 'completed', text: 'untrusted user text' },
      { type: 'message', id: 'public', role: 'assistant', status: 'completed', text: 'never use snapshot text' },
    ] }, runtime: { cwd: '/private/path' } } as unknown as Snapshot;
}

function publicMessage(externalRef: string, overrides: Partial<HeadMessage> = {}): HeadMessage {
  return { externalRef, messageId: 'committed-id', sequence: 1, channelId: 'team',
    author: { kind: 'pet', id: 'pet-a' }, body: 'The first table is checked.', mentions: [],
    occurredAt: '2026-11-20T01:01:00Z', ...overrides };
}

test('one exact snapshot projects matching public Channel facts and nothing internal', async () => {
  const context = { messages: [
    publicMessage('public', { channelId: 'other' }),
    publicMessage('public', { author: { kind: 'pet', id: 'other' } }),
    publicMessage('public', { author: { kind: 'human', id: 'pet-a' } }),
    publicMessage('public'), publicMessage('public'), publicMessage('private'), publicMessage('fake-role'),
  ] };
  let reads = 0;
  const result = await readHeadProgress({ active, run, context, signal, petId: 'pet-a', channelId: 'team', isCurrent: () => true,
    snapshot: async id => { reads++; assert.equal(id, active.sessionId); return snapshot(); } });
  assert.equal(reads, 1);
  assert.deepEqual(result, { status: 'running', publishedUpdates: [{ messageId: 'committed-id', text: 'The first table is checked.' }] });
});

test('rare races, wrong session or request, abort and read failure do not expose prior progress', async () => {
  for (const failure of ['different-run', 'different-session', 'lost', 'abort', 'error'] as const) {
    const controller = new AbortController();
    let current = true;
    const result = await readHeadProgress({ active, run, context: { messages: [publicMessage('public')] },
      signal: controller.signal, petId: 'pet-a', channelId: 'team', isCurrent: () => current,
      snapshot: async () => {
        if (failure === 'error') throw new Error('private checkpoint path');
        if (failure === 'abort') controller.abort();
        if (failure === 'lost') current = false;
        const value = snapshot(failure === 'different-run' ? 'run-b' : 'run-a');
        if (failure === 'different-session') value.session.sessionId = 'wrong-session';
        return value;
      } });
    assert.deepEqual(result, { status: 'unavailable' }, failure);
  }
  let touched = false;
  assert.deepEqual(await readHeadProgress({ active, run, context: { messages: [] },
    signal, petId: 'pet-a', channelId: 'team', isCurrent: () => false,
    snapshot: async () => { touched = true; return snapshot(); } }), { status: 'unavailable' });
  assert.equal(touched, false);
});
