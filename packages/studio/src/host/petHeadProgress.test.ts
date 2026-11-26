import assert from 'node:assert/strict';
import test from 'node:test';
import type { StudioEvent, StudioEventHandler, StudioEventSubscriptionFilter } from '../studioContract';
import { observeHeadRun } from './petHead';
import { headProgress, readHeadSession } from './petHeadProgress';

const active = { dispatchId: 'dispatch-a', sessionId: 'shared-session', messageId: 'question-a' };
const run = { invocationId: active.dispatchId, sessionId: active.sessionId, requestId: 'run-a' };
const signal = new AbortController().signal;

async function readHeadProgress(input: Parameters<typeof readHeadSession>[0] & { run: typeof run }) {
  return headProgress(await readHeadSession(input), input.run.requestId);
}

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
  await listener?.(event('message', { requestId: 'prior', message: { type: 'message.completed', messageId: 'old-result' } }));
  assert.equal(observation.readResult(active), undefined);
  await listener?.(event('message', { message: { type: 'message.completed', messageId: 'public', text: 'do not retain result text' } }));
  assert.deepEqual(observation.readResult(active), { messageId: 'public', requestId: run.requestId });
  await listener?.(event('completed', { requestId: 'old' }));
  assert.deepEqual(observation.read(active), run);
  await listener?.(event('completed', { reply: 'never republish' }));
  assert.equal(observation.read(active), undefined);
  assert.equal(observation.readResult(active), undefined);
  await listener?.(event('running'));
  observation.close();
  assert.equal(listener, undefined);
  assert.equal(observation.read(active), undefined);
});

test('one exact Session status sample yields only running', async () => {
  let reads = 0;
  const result = await readHeadProgress({ run, signal, isCurrent: () => true,
    read: async () => { reads++; return { status: 'running', requestId: run.requestId }; } });
  assert.equal(reads, 1);
  assert.deepEqual(result, { status: 'running' });
});

test('the recorded Session plan remains separate from verified live request status', async () => {
  const recordedPlan = { items: [{ id: 'old', capability: 'check', task: 'Earlier plan objective', status: 'pending' as const }] };
  const read = async () => ({ status: 'running' as const, requestId: run.requestId, recordedPlan });
  assert.deepEqual(await readHeadProgress({ run, signal, isCurrent: () => true, read }),
    { status: 'running', recordedPlan });
  assert.deepEqual(await readHeadProgress({ run, signal, isCurrent: () => true,
    read: async () => ({ status: 'running', requestId: 'older-attempt', recordedPlan }) }), { status: 'unavailable' });
});

test('no active status, changed run, abort and read failure yield unavailable without another sample', async () => {
  for (const failure of ['different-run', 'not-running', 'lost', 'abort', 'error'] as const) {
    const controller = new AbortController();
    let current = true;
    let reads = 0;
    const result = await readHeadProgress({ run, signal: controller.signal, isCurrent: () => current,
      read: async () => {
        reads++;
        if (failure === 'error') throw new Error('private checkpoint path');
        if (failure === 'abort') controller.abort();
        if (failure === 'lost') current = false;
        if (failure === 'not-running') return undefined;
        return { status: 'running', requestId: failure === 'different-run' ? 'run-b' : run.requestId, recordedPlan: { items: [{ id: 'other', capability: 'work', task: 'Must not leak', status: 'pending' }] } };
      } });
    assert.deepEqual(result, { status: 'unavailable' }, failure);
    assert.equal(reads, 1);
  }
  assert.deepEqual(await readHeadProgress({ run, signal, isCurrent: () => false,
    read: async () => assert.fail('no Session read for stale work') }), { status: 'unavailable' });
});
