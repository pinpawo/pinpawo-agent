import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AgentSessionSnapshot } from '@pinpawo/agent-session';
import type { StudioDispatchQueue } from '@pinpawo/studio-core';
import { collectChannelRoutingState } from './channelRoutingState';

const channelId = 'current';
const sampledAt = new Date('2026-01-02T03:04:05.000Z');
const now = () => sampledAt;
type Sources = Parameters<typeof collectChannelRoutingState>[2];
type Session = AgentSessionSnapshot['session'];

function snapshot(sessionId: string, patch: Partial<Session> = {}): AgentSessionSnapshot {
  return { version: 5, session: { sessionId, kind: 'chat', timeline: [], activeRun: null, pendingInterrupt: null, ...patch } };
}

function queue(petId: string, patch: Partial<StudioDispatchQueue> = {}): StudioDispatchQueue {
  return { petId, state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0, ...patch };
}

function entry(sessionId: string, scope?: { namespace: string; id: string }) {
  return { dispatchId: randomUUID(), enqueuedAt: sampledAt.toISOString(), sessionId, ...(scope ? { scope } : {}) };
}

function fixture(queues: StudioDispatchQueue[] = [queue('pet')], patch: Partial<Session> = {}) {
  const reads: Array<{ petId: string; sessionId: string; options: unknown }> = [];
  const bindings: Array<[string, string]> = [];
  let queueReads = 0;
  const sources: Sources = {
    host: {
      listDispatchQueues: () => { queueReads++; return queues; },
      petSessions: { snapshot: async (petId, sessionId, options) => {
        reads.push({ petId, sessionId, options });
        return snapshot(sessionId, patch);
      } },
    },
    channels: { getSession: async (requestedChannel, petId) => {
      bindings.push([requestedChannel, petId]);
      return { channelId: requestedChannel, petId, sessionId: petId + ':session', registered: true };
    } },
  };
  return { sources, reads, bindings, queueReads: () => queueReads };
}

test('reads only each candidate current binding and projects a compact idle state', async () => {
  const f = fixture([queue('one'), queue('two')]);
  const result = await collectChannelRoutingState(channelId, ['one', 'two', 'one'], f.sources, { now });
  assert.equal(f.queueReads(), 1);
  assert.deepEqual(f.bindings, [[channelId, 'one'], [channelId, 'two']]);
  assert.deepEqual(f.reads, [
    { petId: 'one', sessionId: 'one:session', options: { timelineLimit: 1 } },
    { petId: 'two', sessionId: 'two:session', options: { timelineLimit: 1 } },
  ]);
  for (const runtime of Object.values(result)) assert.deepEqual(runtime, {
    sampledAt: sampledAt.toISOString(), sessionState: 'idle', admissionState: 'open', activeScope: 'none', queuedInSession: 0,
  });
});

test('running exact session remains distinct from global admission and exact scoped queue count', async () => {
  const scope = { namespace: 'channel', id: channelId };
  const f = fixture([queue('pet', { state: 'busy', activeOperation: 'dispatch', activeDispatch: entry('pet:session', scope),
    queuedDispatches: 3, entries: [entry('pet:session', scope), entry('pet:session', { namespace: 'other', id: channelId }), entry('elsewhere', scope)] })],
  { activeRun: { requestId: 'running' } as Session['activeRun'] });
  const result = (await collectChannelRoutingState(channelId, ['pet'], f.sources, { now })).pet;
  assert.deepEqual(result, { sampledAt: sampledAt.toISOString(), sessionState: 'running', admissionState: 'busy', activeScope: 'current-channel', queuedInSession: 1 });
});

test('global waiting does not claim the current session is waiting', async () => {
  const f = fixture([queue('pet', { state: 'waiting', queuedDispatches: 1, entries: [entry('different-session', { namespace: 'channel', id: 'other' })] })]);
  assert.deepEqual((await collectChannelRoutingState(channelId, ['pet'], f.sources, { now })).pet,
    { sampledAt: sampledAt.toISOString(), sessionState: 'idle', admissionState: 'waiting', activeScope: 'none', queuedInSession: 0 });
});

test('current pending review exposes only its kind, without private timeline, payload or other work', async () => {
  const marker = randomUUID();
  const pending = { interruptId: marker, payload: { kind: 'human_review' as const, interactions: [], privateMarker: marker } };
  const f = fixture([queue('pet', { state: 'busy', activeOperation: 'dispatch', activeDispatch: entry(marker, { namespace: 'channel', id: marker }) })],
    { pendingInterrupt: pending, runtime: { cwd: marker } });
  const result = await collectChannelRoutingState(channelId, ['pet'], f.sources, { now });
  assert.deepEqual(result.pet, { sampledAt: sampledAt.toISOString(), sessionState: 'waiting', admissionState: 'busy', activeScope: 'other-channel', queuedInSession: 0, waitingKind: 'human_review' });
  assert.equal(JSON.stringify(result).includes(marker), false);
});

test('scope classification does not mistake a same-channel different session or conversation for this run', async () => {
  const cases: Array<[Partial<StudioDispatchQueue>, string]> = [
    [{ activeDispatch: entry('elsewhere', { namespace: 'channel', id: channelId }) }, 'unknown'],
    [{ activeDispatch: entry('elsewhere', { namespace: 'channel', id: 'another' }) }, 'other-channel'],
    [{ activeDispatch: entry('elsewhere', { namespace: 'project', id: 'another' }) }, 'other-scope'],
    [{ activeDispatch: entry('elsewhere') }, 'unscoped'],
    [{ activeOperation: 'conversation' }, 'unknown'],
  ];
  for (const [patch, expected] of cases) {
    const f = fixture([queue('pet', { state: 'busy', activeOperation: 'dispatch', ...patch })]);
    const result = (await collectChannelRoutingState(channelId, ['pet'], f.sources, { now })).pet;
    assert.equal(result.activeScope, expected);
    assert.equal(result.sessionState, 'idle');
  }
});

test('an absent binding is unbound and an unregistered binding is unknown, without snapshot reads', async () => {
  const f = fixture();
  f.sources.channels.getSession = async () => undefined;
  assert.equal((await collectChannelRoutingState(channelId, ['pet'], f.sources, { now })).pet.sessionState, 'unbound');
  f.sources.channels.getSession = async () => ({ channelId, petId: 'pet', sessionId: 'reserved', registered: false });
  assert.equal((await collectChannelRoutingState(channelId, ['pet'], f.sources, { now })).pet.sessionState, 'unknown');
  assert.equal(f.reads.length, 0);
});

test('incomplete queue observations never manufacture an exact current-session zero', async () => {
  const cases: Partial<StudioDispatchQueue>[] = [
    { queuedDispatches: 1 },
    { queuedDispatches: 2, entries: [entry('different', { namespace: 'channel', id: 'other' })] },
    { queuedDispatches: 1, entries: [{ dispatchId: 'unknown-target', enqueuedAt: sampledAt.toISOString() }] },
    { queuedDispatches: 1, entries: [entry('pet:session')] },
  ];
  for (const patch of cases) {
    const f = fixture([queue('pet', patch)]);
    assert.equal((await collectChannelRoutingState(channelId, ['pet'], f.sources, { now })).pet.queuedInSession, null);
  }
});

test('queue and session read failures remain separate and do not leak error text', async () => {
  const marker = randomUUID();
  const f = fixture();
  f.sources.host.listDispatchQueues = () => { throw new Error(marker); };
  const queueFailed = (await collectChannelRoutingState(channelId, ['pet'], f.sources, { now })).pet;
  assert.deepEqual(queueFailed, { sampledAt: sampledAt.toISOString(), sessionState: 'idle', admissionState: 'unknown', activeScope: 'unknown', queuedInSession: null });
  f.sources.host.listDispatchQueues = () => [queue('pet', { state: 'blocked' })];
  f.sources.host.petSessions.snapshot = async () => { throw new Error(marker); };
  const sessionFailed = (await collectChannelRoutingState(channelId, ['pet'], f.sources, { now })).pet;
  assert.deepEqual(sessionFailed, { sampledAt: sampledAt.toISOString(), sessionState: 'unknown', admissionState: 'blocked', activeScope: 'none', queuedInSession: 0 });
  f.sources.channels.getSession = async () => { throw new Error(marker); };
  const bindingFailed = (await collectChannelRoutingState(channelId, ['pet'], f.sources, { now })).pet;
  assert.equal(bindingFailed.sessionState, 'unknown');
  assert.equal(JSON.stringify([queueFailed, sessionFailed, bindingFailed]).includes(marker), false);
});

test('wrong binding and wrong snapshot identities cannot become current-session state', async () => {
  const f = fixture();
  f.sources.channels.getSession = async () => ({ channelId: 'different', petId: 'pet', sessionId: 'elsewhere', registered: true });
  assert.equal((await collectChannelRoutingState(channelId, ['pet'], f.sources, { now })).pet.sessionState, 'unknown');
  assert.equal(f.reads.length, 0);
  f.sources.channels.getSession = async () => ({ channelId, petId: 'pet', sessionId: 'pet:session', registered: true });
  f.sources.host.petSessions.snapshot = async () => snapshot('different');
  assert.equal((await collectChannelRoutingState(channelId, ['pet'], f.sources, { now })).pet.sessionState, 'unknown');
});

test('candidates read concurrently and a stuck snapshot shares the batch deadline', { timeout: 1_000 }, async () => {
  const f = fixture([queue('slow'), queue('fast')]);
  const called: string[] = [];
  f.sources.host.petSessions.snapshot = async (petId, sessionId) => {
    called.push(petId);
    return petId === 'slow' ? new Promise<AgentSessionSnapshot>(() => {}) : snapshot(sessionId);
  };
  const result = await collectChannelRoutingState(channelId, ['slow', 'fast'], f.sources, { now, timeoutMs: 10 });
  assert.deepEqual(called, ['slow', 'fast']);
  assert.equal(result.slow.sessionState, 'unknown');
  assert.equal(result.fast.sessionState, 'idle');
});

test('a late binding cannot start a snapshot after collection timed out', { timeout: 1_000 }, async () => {
  const f = fixture();
  let release!: (value: Awaited<ReturnType<Sources['channels']['getSession']>>) => void;
  f.sources.channels.getSession = () => new Promise(resolve => { release = resolve; });
  const result = await collectChannelRoutingState(channelId, ['pet'], f.sources, { now, timeoutMs: 10 });
  const frozen = JSON.stringify(result);
  release({ channelId, petId: 'pet', sessionId: 'pet:session', registered: true });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.reads.length, 0);
  assert.equal(JSON.stringify(result), frozen);
});

test('snapshot timeout retains known scoped queue facts and ignores a late successful read', { timeout: 1_000 }, async () => {
  const scope = { namespace: 'channel', id: channelId };
  const f = fixture([queue('pet', { state: 'busy', activeOperation: 'dispatch', activeDispatch: entry('pet:session', scope),
    queuedDispatches: 1, entries: [entry('pet:session', scope)] })]);
  let release!: (value: AgentSessionSnapshot) => void;
  f.sources.host.petSessions.snapshot = () => new Promise(resolve => { release = resolve; });
  const result = await collectChannelRoutingState(channelId, ['pet'], f.sources, { now, timeoutMs: 10 });
  assert.deepEqual(result.pet, { sampledAt: sampledAt.toISOString(), sessionState: 'unknown', admissionState: 'busy', activeScope: 'current-channel', queuedInSession: 1 });
  release(snapshot('pet:session', { activeRun: { requestId: 'late' } as Session['activeRun'] }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(result.pet.sessionState, 'unknown');
});
