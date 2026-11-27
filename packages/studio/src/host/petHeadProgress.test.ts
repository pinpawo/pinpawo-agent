import assert from 'node:assert/strict';
import test from 'node:test';
import type { StudioEvent, StudioEventHandler, StudioEventSubscriptionFilter } from '../studioContract';
import { observeHeadDispatch, readHeadProgress } from './petHeadProgress';

const active = { dispatchId: 'dispatch-a', sessionId: 'shared-session', messageId: 'question-a' };
const run = { invocationId: active.dispatchId, sessionId: active.sessionId, requestId: 'run-a' };
const signal = new AbortController().signal;

function event(type: string, overrides: Record<string, unknown> = {}): StudioEvent {
  return { type: `dispatch.${type}`, eventId: type, source: 'resident-pet', topic: 'pet-a', occurredAt: '2026-11-20T01:01:00Z',
    payload: { petId: 'pet-a', invocationId: active.dispatchId, sessionId: active.sessionId, requestId: run.requestId,
      scope: { namespace: 'channel', id: 'team' }, request: 'raw original request', ...overrides } };
}
test('one exact Session status sample yields only running', async () => {
  let reads = 0;
  const result = await readHeadProgress({ run, signal, isCurrent: () => true,
    readSessionRun: async id => { reads++; assert.equal(id, run.sessionId); return { requestId: run.requestId }; } });
  assert.equal(reads, 1);
  assert.deepEqual(result, { status: 'running' });
});

test('the recorded Session plan remains separate from verified live request status', async () => {
  const recordedPlan = { items: [{ id: 'old', capability: 'check', task: 'Earlier plan objective', status: 'pending' as const }] };
  const readSessionRun = async () => ({ requestId: run.requestId, recordedPlan });
  assert.deepEqual(await readHeadProgress({ run, signal, isCurrent: () => true, readSessionRun }),
    { status: 'running', recordedPlan });
  assert.deepEqual(await readHeadProgress({ run, signal, isCurrent: () => true,
    readSessionRun: async () => ({ requestId: 'older-attempt', recordedPlan }) }), { status: 'unavailable' });
});

test('no active status, changed run, abort and read failure yield unavailable without another sample', async () => {
  for (const failure of ['different-run', 'not-running', 'lost', 'abort', 'error'] as const) {
    const controller = new AbortController();
    let current = true;
    let reads = 0;
    const result = await readHeadProgress({ run, signal: controller.signal, isCurrent: () => current,
      readSessionRun: async () => {
        reads++;
        if (failure === 'error') throw new Error('private checkpoint path');
        if (failure === 'abort') controller.abort();
        if (failure === 'lost') current = false;
        if (failure === 'not-running') return undefined;
        return { requestId: failure === 'different-run' ? 'run-b' : run.requestId, recordedPlan: { items: [{ id: 'other', capability: 'work', task: 'Must not leak', status: 'pending' }] } };
      } });
    assert.deepEqual(result, { status: 'unavailable' }, failure);
    assert.equal(reads, 1);
  }
  assert.deepEqual(await readHeadProgress({ run, signal, isCurrent: () => false,
    readSessionRun: async () => assert.fail('no Session read for stale work') }), { status: 'unavailable' });
});

test('readSession combines scoped coordinator facts and one Session Plan, not raw events', async () => {
  let listener: StudioEventHandler | undefined;
  let filter: StudioEventSubscriptionFilter | undefined;
  const a = { ...active, enqueuedAt: '2026-11-20T01:01:00Z',
    scope: { namespace: 'channel', id: 'team' }, origin: { namespace: 'channel', id: active.messageId } };
  const b = { ...a, dispatchId: 'dispatch-b', origin: { ...a.origin, id: 'question-b' } };
  const other = { ...a, dispatchId: 'other', scope: { ...a.scope, id: 'other' } };
  let current: typeof a | undefined = a;
  const observer = observeHeadDispatch({
    petId: 'pet-a', channelId: 'team',
    subscribe: (handler, selected) => {
      listener = handler; filter = selected;
      return () => { listener = undefined; };
    },
    snapshot: () => ({ state: current ? 'busy' : 'open', activeOperation: current ? 'dispatch' : null,
      queuedConversations: 0, queuedDispatches: 2, entries: [b, other], activeDispatch: current }),
  }, signal);
  const sources = new Set(['question-a', 'question-b']);
  const readSession = () => observer.readSession(active.sessionId, sources, async (id) => {
    assert.equal(id, active.sessionId);
    return { requestId: run.requestId,
      recordedPlan: { items: [{ id: 'internal', capability: 'internal', task: 'Latest recorded step', status: 'completed' }] } };
  });
  assert.deepEqual(filter, { source: 'resident-pet', topic: 'pet-a' });
  await listener?.({ ...event('running'), topic: 'other' });
  assert.ok((await readSession()).every(fact => fact.plan === undefined));
  await listener?.(event('running', { origin: a.origin }));
  await listener?.(event('completed', { requestId: 'old', origin: a.origin }));
  assert.deepEqual(await readSession(), [
    { messageId: 'question-b', status: 'queued' },
    { messageId: 'question-a', status: 'running', plan: [{ status: 'completed', description: 'Latest recorded step' }] },
  ]);
  current = undefined;
  assert.deepEqual(await readSession(), [{ messageId: 'question-b', status: 'queued' }], 'queue absence never means completion');
  await listener?.(event('waiting', { origin: a.origin }));
  assert.equal((await readSession()).find(fact => fact.messageId === 'question-a')?.status, 'waiting');
  current = a; // The Coordinator can still hold its slot during final settlement.
  await listener?.(event('completed', { reply: 'contents not retained' }));
  assert.deepEqual(await readSession(), [
    { messageId: 'question-a', status: 'completed' }, { messageId: 'question-b', status: 'queued' },
  ]);
  observer.close();
  assert.equal(listener, undefined);
});
