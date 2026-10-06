import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryHostPersistence } from './memoryHostPersistence';
import { createFileHostPersistence } from './fileHostPersistence';
import { ServerTuiSessionService } from '../session/serverTuiSessions';
import { buildHostRuntimeConfig } from '../config/runtimeConfig';
import type { UsageFilter, UsageObservation, UsageStorePort } from '../hostRuntime';

async function admitted(p = createMemoryHostPersistence({ defaultModelProfileId: 'profile' })) {
  const session = (await p.sessions.register('pet', 'pet:12345678', true));
  const input = { dispatchId: 'dispatch', petId: 'pet', sessionId: session.id, threadId: session.threadId,
    request: 'inspect', scope: { namespace: 'channel', id: 'a' }, idempotencyKey: 'key', fingerprint: 'request-a' };
  const record = (await p.invocations.admit(input)).record;
  return { p, session, input, record };
}
const identity = (threadId: string) => ({ threadId, taskId: 'runtime-task', runId: 'runtime-run' });

test('usage is unavailable by default, including the existing file adapter after restart', async () => {
  assert.equal(createMemoryHostPersistence({ defaultModelProfileId: 'profile' }).usage, undefined);
  const root = mkdtempSync(join(tmpdir(), 'host-usage-unavailable-'));
  try {
    const file = join(root, 'registry.json');
    const { p, input } = (await admitted((await createFileHostPersistence(file, 'profile'))));
    assert.equal(p.usage, undefined);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(raw).sort(), ['activeSessionIds', 'hostPersistenceVersion', 'invocations', 'sessions', 'version']);
    assert.equal(raw.hostPersistenceVersion, 1);
    const reopened = (await createFileHostPersistence(file, 'profile'));
    assert.equal(reopened.usage, undefined);
    assert.equal((await reopened.invocations.read(input.dispatchId))?.scope?.id, 'a');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('injected usage adapter preserves async results/errors and stays outside invocation commits', async () => {
  const observation: UsageObservation = {
    sourceId: 'runtime-source', eventId: 'event', revision: 1, attemptId: 'attempt',
    runtime: identity('opaque-thread'), requestId: 'resume-request', planItemId: 'plan-item', delegationId: 'delegation',
    usage: { input: null, output: 0, total: null },
  };
  const filter: UsageFilter = { runtime: observation.runtime, requestId: observation.requestId,
    planItemId: observation.planItemId, delegationId: observation.delegationId };
  const outcomes = ['recorded', 'duplicate', 'stale'] as const;
  let commits = 0, records = 0;
  const unavailable = new Error('usage adapter unavailable');
  const usage: UsageStorePort = {
    record: async value => {
      assert.equal(value, observation);
      const result = outcomes[records++];
      if (!result) throw unavailable;
      return result;
    },
    list: async (query, cursor) => {
      assert.equal(query, filter);
      assert.equal(cursor, 'opaque-cursor');
      return { records: [observation], nextCursor: 'opaque-next' };
    },
  };
  const { p, input } = (await admitted(createMemoryHostPersistence({ defaultModelProfileId: 'profile', usage, commit: async () => { commits++; } })));
  const before = (await p.invocations.read(input.dispatchId));
  const admissionCommits = commits;
  assert.equal(p.usage, usage);
  for (const expected of outcomes) assert.equal(await p.usage.record(observation), expected);
  const page = await p.usage.list(filter, 'opaque-cursor');
  assert.equal(page.records[0].usage.input, null);
  assert.equal(page.records[0].usage.output, 0);
  assert.equal(page.nextCursor, 'opaque-next');
  await assert.rejects(p.usage.record(observation), error => error === unavailable);
  assert.equal(commits, admissionCommits);
  assert.deepEqual((await p.invocations.read(input.dispatchId)), before);
  assert.equal((await p.invocations.claimStart(input.dispatchId, before!.revision, 'start')).state, 'running');
});

test('durable admission is idempotent and rejects changed identities; failed commit leaves no execution claim', async () => {
  let fail = false;
  const p = createMemoryHostPersistence({ defaultModelProfileId: 'profile', commit: async () => { if (fail) throw Error('disk unavailable'); } });
  const { input } = (await admitted(p));
  assert.equal((await p.invocations.admit({ ...input, dispatchId: 'other' })).created, false);
  await assert.rejects(async () => (await p.invocations.admit({ ...input, fingerprint: 'changed' })), /conflict/);
  fail = true;
  await assert.rejects(async () => (await p.invocations.claimStart(input.dispatchId, 0, 'chunk')), /disk unavailable/);
  assert.equal((await p.invocations.read(input.dispatchId))?.state, 'queued');
  assert.equal((await p.invocations.read(input.dispatchId))?.revision, 0);
  await assert.rejects(async () => (await p.invocations.admit({ ...input, idempotencyKey: 'new', dispatchId: 'new' })), /disk unavailable/);
  assert.equal((await p.invocations.read('new')), null);
});

test('waiting resumes by runtime identity/revision, clears pending on settlement and rejects stale chunks', async () => {
  const { p, record, session } = (await admitted());
  const store = p.invocations;
  let current = (await store.claimStart(record.dispatchId, record.revision, 'start'));
  current = (await store.attachRuntimeIdentity(current.dispatchId, current.revision, identity(session.threadId)));
  const pending = { interruptId: 'interrupt', payload: { kind: 'human_review', reviews: [] } } as never;
  current = (await store.markWaiting(current.dispatchId, current.revision, pending));
  await assert.rejects(async () => (await store.claimResume(current.dispatchId, current.revision, 'resume', { ...identity(session.threadId), runId: 'wrong' }, 'interrupt')), /identity/);
  await assert.rejects(async () => (await store.claimResume(current.dispatchId, current.revision, 'resume', identity(session.threadId), 'wrong')), /identity/);
  const waiting = current;
  current = (await store.claimResume(current.dispatchId, current.revision, 'resume', identity(session.threadId), 'interrupt'));
  await assert.rejects(async () => (await store.claimResume(waiting.dispatchId, waiting.revision, 'duplicate', identity(session.threadId), 'interrupt')), /conflict/);
  await assert.rejects(async () => (await store.settle(current.dispatchId, waiting.revision, { state: 'completed', reply: 'old' })), /conflict/);
  current = (await store.settle(current.dispatchId, current.revision, { state: 'completed', reply: 'done' }));
  assert.equal(current.pendingInterrupt, undefined);
  assert.equal(current.scope?.id, 'a');
  assert.deepEqual((await store.settle(current.dispatchId, current.revision, { state: 'completed', reply: 'done' })), current);
  await assert.rejects(async () => (await store.settle(current.dispatchId, current.revision, { state: 'failed', error: 'late' })), /settlement conflict/);
});

test('legacy registry migrates in place; service and invocation adapter share one authority across restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-migration-'));
  try {
    const file = join(root, 'sessions.json');
    const legacy = createMemoryHostPersistence({ defaultModelProfileId: 'profile' });
    const session = (await legacy.sessions.register('pet', 'pet:12345678', true));
    writeFileSync(file, JSON.stringify({ version: 2, activeSessionIds: { pet: session.id }, sessions: { [session.id]: {
      ...session, modelProfileId: undefined, requiredInputModalities: undefined,
    } } }));
    const persistence = (await createFileHostPersistence(file, 'profile'));
    const service = new ServerTuiSessionService({ runtimeConfig: buildHostRuntimeConfig(root), registry: persistence.sessions });
    assert.equal((await service.getActiveSession('pet')).id, session.id);
    assert.equal((await service.getChatThreadId('pet')), session.threadId);
    const { input } = (await admitted(persistence));
    (await service.selectModelProfile('pet', session.id, 'second'));
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.version, 4);
    assert.equal(raw.hostPersistenceVersion, 1);
    assert.equal(raw.invocations[input.dispatchId].sessionId, session.id);
    assert.equal(raw.sessions[session.id].modelProfileId, 'second');
    const reopened = (await createFileHostPersistence(file, 'profile'));
    assert.equal((await reopened.invocations.read(input.dispatchId))?.scope?.id, 'a');
    assert.equal((await reopened.sessions.active('pet'))?.modelProfileId, 'second');
    assert.equal((await reopened.sessions.list()).length, 1);
    writeFileSync(file, '{broken');
    await assert.rejects(async () => (await createFileHostPersistence(file, 'profile')));
    await assert.rejects(async () => (await persistence.sessions.updateProfile(session.id, 'lost')), /single writer/);
    assert.equal((await persistence.sessions.read(session.id))?.modelProfileId, 'second');
    assert.equal(readFileSync(file, 'utf8'), '{broken');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('session identity conflicts and removal of unresolved invocation fail closed', async () => {
  const { p, session } = (await admitted());
  await assert.rejects(async () => (await p.sessions.register('other', session.id, true)), /another Pet/);
  await assert.rejects(async () => (await p.sessions.remove(session.id)), /unresolved/);
  const detached = (await p.sessions.read(session.id))!;
  detached.threadId = 'tampered';
  assert.equal((await p.sessions.read(session.id))?.threadId, session.threadId);
});

test('compatibility session writes preserve invocation facts and refuse orphaning them', async () => {
  const { saveTuiSessionState, loadTuiSessionState } = await import('../session/tuiSessionRegistry');
  const root = mkdtempSync(join(tmpdir(), 'host-legacy-facade-'));
  try {
    const file = join(root, 'registry.json');
    const { input } = (await admitted((await createFileHostPersistence(file, 'profile'))));
    const registry = (await loadTuiSessionState('profile', file));
    (await saveTuiSessionState(registry, file));
    assert.equal((await (await createFileHostPersistence(file, 'profile')).invocations.read(input.dispatchId))?.dispatchId, input.dispatchId);
    delete registry.sessions[input.sessionId];
    await assert.rejects(async () => (await saveTuiSessionState(registry, file)), /orphan/);
    assert.ok(await (await createFileHostPersistence(file, 'profile')).sessions.read(input.sessionId));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only unstarted legacy calls can persist active-session selection at dequeue', async () => {
  const p = createMemoryHostPersistence({ defaultModelProfileId: 'profile' });
  const first = (await p.sessions.create('pet'));
  const next = (await p.sessions.create('pet'));
  let record = (await p.invocations.admit({ dispatchId: 'legacy', petId: 'pet', sessionId: first.id,
    threadId: first.threadId, request: 'legacy', fingerprint: 'legacy' })).record;
  record = (await p.invocations.bindLegacyQueuedSession(record.dispatchId, record.revision, next.id));
  assert.equal(record.threadId, next.threadId);
  record = (await p.invocations.claimStart(record.dispatchId, record.revision, 'start'));
  await assert.rejects(async () => (await p.invocations.bindLegacyQueuedSession(record.dispatchId, record.revision, first.id)), /conflict/);
  const { record: scoped } = (await admitted(p));
  await assert.rejects(async () => (await p.invocations.bindLegacyQueuedSession(scoped.dispatchId, scoped.revision, next.id)), /legacy/);
});

test('async commit serializes duplicate admissions and competing resume claims; failed settlement publishes nothing', async () => {
  let enter!: () => void, release!: () => void;
  let entered = new Promise<void>(resolve => { enter = resolve; });
  let pending = new Promise<void>(resolve => { release = resolve; });
  let hold = false, fail = false, commits = 0;
  const p = createMemoryHostPersistence({ defaultModelProfileId: 'profile', commit: async () => {
    if (fail) throw new Error('durable settlement unavailable');
    commits++;
    if (hold) { enter(); await pending; }
  } });
  const session = await p.sessions.register('pet', 'pet:12345678', true);
  const input = { dispatchId: 'first', petId: 'pet', sessionId: session.id, threadId: session.threadId,
    request: 'once', idempotencyKey: 'stable', fingerprint: 'same' };
  const baseline = commits;
  hold = true;
  const admissions = Promise.all([p.invocations.admit(input), p.invocations.admit({ ...input, dispatchId: 'redelivery' })]);
  await entered; release();
  const [first, duplicate] = await admissions;
  hold = false;
  assert.equal(first.created, true); assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.dispatchId, first.record.dispatchId); assert.equal(commits - baseline, 1);
  await assert.rejects(p.invocations.admit({ ...input, dispatchId: 'changed', fingerprint: 'different metadata' }), /identity conflict/);
  let record = await p.invocations.claimStart(first.record.dispatchId, first.record.revision, 'start');
  record = await p.invocations.attachRuntimeIdentity(record.dispatchId, record.revision, identity(session.threadId));
  record = await p.invocations.markWaiting(record.dispatchId, record.revision, { interruptId: 'review', payload: { kind: 'human_review', reviews: [] } } as never);
  entered = new Promise<void>(resolve => { enter = resolve; });
  pending = new Promise<void>(resolve => { release = resolve; });
  hold = true;
  const claims = Promise.allSettled([
    p.invocations.claimResume(record.dispatchId, record.revision, 'resume', identity(session.threadId), 'review'),
    p.invocations.claimResume(record.dispatchId, record.revision, 'duplicate-resume', identity(session.threadId), 'review'),
  ]);
  await entered; release();
  const results = await claims;
  hold = false;
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const before = await p.invocations.read(record.dispatchId);
  const { HostInvocationService } = await import('./hostInvocationService');
  const events: unknown[] = [];
  const service = new HostInvocationService(p.invocations, event => events.push(event));
  fail = true;
  await assert.rejects(service.observe({ dispatchId: record.dispatchId, request: input.request, requestId: 'resume', state: 'completed', reply: 'done' }), /durable settlement unavailable/);
  assert.deepEqual(await p.invocations.read(record.dispatchId), before);
  assert.deepEqual(events, []);
});

test('a resume result commit failure preserves its running claim and original scope', async () => {
  let fail = false;
  const p = createMemoryHostPersistence({ defaultModelProfileId: 'profile', commit: async state => {
    if (fail && state.invocations.dispatch.state === 'completed') throw new Error('resume result unavailable');
  } });
  const { record, session } = await admitted(p);
  let current = await p.invocations.claimStart(record.dispatchId, record.revision, 'start');
  current = await p.invocations.attachRuntimeIdentity(current.dispatchId, current.revision, identity(session.threadId));
  const pending = { interruptId: 'review', payload: { kind: 'human_review', reviews: [] } } as never;
  await p.invocations.markWaiting(current.dispatchId, current.revision, pending);
  const { HostInvocationService } = await import('./hostInvocationService');
  const events: string[] = [];
  const service = new HostInvocationService(p.invocations, event => events.push(event.state));
  const options = { sessionId: session.id, setup: { input: { threadId: session.threadId } },
    request: { kind: 'resume', requestId: 'resume', resume: { interruptId: 'review' } },
    graphService: { readExecutionDescriptor: async () => ({ state: 'waiting', identity: identity(session.threadId), pendingInterrupt: pending }) },
    emitEvent: () => {},
  } as never;
  fail = true;
  await assert.rejects(service.runTurn(options, 'pet', async () => ({ status: 'completed', reply: 'done' })), /resume result unavailable/);
  const preserved = await p.invocations.read(record.dispatchId);
  assert.equal(preserved?.state, 'running'); assert.equal(preserved?.requestId, 'resume');
  assert.deepEqual(preserved?.scope, record.scope); assert.deepEqual(events, ['running']);
});
