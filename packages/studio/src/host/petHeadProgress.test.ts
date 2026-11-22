import assert from 'node:assert/strict';
import test from 'node:test';
import type { StudioEvent, StudioEventHandler, StudioEventSubscriptionFilter } from '../studioContract';
import { observeHeadRun } from './petHead';
import { readHeadProgress } from './petHeadProgress';

const active = { dispatchId: 'dispatch-a', sessionId: 'shared-session', messageId: 'question-a' };
const run = { invocationId: active.dispatchId, sessionId: active.sessionId, requestId: 'run-a' };
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
  assert.deepEqual(observation.read(active), run);
  assert.equal(observation.read({ ...active, sessionId: 'other' }), undefined);
  await listener?.(event('message', { message: { type: 'message.completed', messageId: 'public', text: 'do not retain result text' } }));
  await listener?.(event('completed', { requestId: 'old' }));
  assert.deepEqual(observation.read(active), run);
  await listener?.(event('completed', { reply: 'never republish' }));
  assert.equal(observation.read(active), undefined);
  await listener?.(event('running'));
  observation.close();
  assert.equal(listener, undefined);
  assert.equal(observation.read(active), undefined);
});

test('one exact Session status sample yields only running', async () => {
  let reads = 0;
  const result = await readHeadProgress({ run, signal, isCurrent: () => true,
    readSessionRun: async id => { reads++; assert.equal(id, run.sessionId); return { requestId: run.requestId }; } });
  assert.equal(reads, 1);
  assert.deepEqual(result, { status: 'running' });
});

test('eligible evidence travels only with the exact solicited current run', async () => {
  const runProgress = { latestDelivery: 'A delivered.', pendingObjectives: ['B still pending'] };
  const readSessionRun = async () => ({ requestId: run.requestId, runProgress });
  assert.deepEqual(await readHeadProgress({ run, signal, isCurrent: () => true, readSessionRun }), { status: 'running' });
  assert.deepEqual(await readHeadProgress({ run, signal, isCurrent: () => true, readSessionRun, includeRunProgress: true }),
    { status: 'running', ...runProgress });
  assert.deepEqual(await readHeadProgress({ run, signal, isCurrent: () => true, includeRunProgress: true,
    readSessionRun: async () => ({ requestId: 'older-attempt', runProgress }) }), { status: 'unavailable' });
});

test('no active status, changed run, abort and read failure yield unavailable without another sample', async () => {
  for (const failure of ['different-run', 'not-running', 'lost', 'abort', 'error'] as const) {
    const controller = new AbortController();
    let current = true;
    let reads = 0;
    const result = await readHeadProgress({ run, signal: controller.signal, isCurrent: () => current, includeRunProgress: true,
      readSessionRun: async () => {
        reads++;
        if (failure === 'error') throw new Error('private checkpoint path');
        if (failure === 'abort') controller.abort();
        if (failure === 'lost') current = false;
        if (failure === 'not-running') return undefined;
        return { requestId: failure === 'different-run' ? 'run-b' : run.requestId, runProgress: { latestDelivery: 'Must not leak' } };
      } });
    assert.deepEqual(result, { status: 'unavailable' }, failure);
    assert.equal(reads, 1);
  }
  assert.deepEqual(await readHeadProgress({ run, signal, isCurrent: () => false,
    readSessionRun: async () => assert.fail('no Session read for stale work') }), { status: 'unavailable' });
});
