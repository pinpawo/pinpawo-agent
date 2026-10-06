import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostPersistence } from './hostPersistence';
import { createFileHostPersistence } from './fileHostPersistence';
import { ServerTuiSessionService } from '../session/serverTuiSessions';
import { buildHostRuntimeConfig } from '../config/runtimeConfig';

function admitted(p = createHostPersistence({ defaultModelProfileId: 'profile' })) {
  const session = p.sessions.register('pet', 'pet:12345678', true);
  const input = { dispatchId: 'dispatch', petId: 'pet', sessionId: session.id, threadId: session.threadId,
    request: 'inspect', scope: { namespace: 'channel', id: 'a' }, idempotencyKey: 'key', fingerprint: 'request-a' };
  const record = p.invocations.admit(input).record;
  return { p, session, input, record };
}
const identity = (threadId: string) => ({ threadId, taskId: 'runtime-task', runId: 'runtime-run' });

test('durable admission is idempotent and rejects changed identities; failed commit leaves no execution claim', () => {
  let fail = false;
  const p = createHostPersistence({ defaultModelProfileId: 'profile', commit: () => { if (fail) throw Error('disk unavailable'); } });
  const { input } = admitted(p);
  assert.equal(p.invocations.admit({ ...input, dispatchId: 'other' }).created, false);
  assert.throws(() => p.invocations.admit({ ...input, fingerprint: 'changed' }), /conflict/);
  fail = true;
  assert.throws(() => p.invocations.claimStart(input.dispatchId, 0, 'chunk'), /disk unavailable/);
  assert.equal(p.invocations.read(input.dispatchId)?.state, 'queued');
  assert.equal(p.invocations.read(input.dispatchId)?.revision, 0);
  assert.throws(() => p.invocations.admit({ ...input, idempotencyKey: 'new', dispatchId: 'new' }), /disk unavailable/);
  assert.equal(p.invocations.read('new'), null);
});

test('waiting resumes by runtime identity/revision, clears pending on settlement and rejects stale chunks', () => {
  const { p, record, session } = admitted();
  const store = p.invocations;
  let current = store.claimStart(record.dispatchId, record.revision, 'start');
  current = store.attachRuntimeIdentity(current.dispatchId, current.revision, identity(session.threadId));
  const pending = { interruptId: 'interrupt', payload: { kind: 'human_review', reviews: [] } } as never;
  current = store.markWaiting(current.dispatchId, current.revision, pending);
  assert.throws(() => store.claimResume(current.dispatchId, current.revision, 'resume', { ...identity(session.threadId), runId: 'wrong' }, 'interrupt'), /identity/);
  assert.throws(() => store.claimResume(current.dispatchId, current.revision, 'resume', identity(session.threadId), 'wrong'), /identity/);
  const waiting = current;
  current = store.claimResume(current.dispatchId, current.revision, 'resume', identity(session.threadId), 'interrupt');
  assert.throws(() => store.claimResume(waiting.dispatchId, waiting.revision, 'duplicate', identity(session.threadId), 'interrupt'), /conflict/);
  assert.throws(() => store.settle(current.dispatchId, waiting.revision, { state: 'completed', reply: 'old' }), /conflict/);
  current = store.settle(current.dispatchId, current.revision, { state: 'completed', reply: 'done' });
  assert.equal(current.pendingInterrupt, undefined);
  assert.equal(current.scope?.id, 'a');
  assert.deepEqual(store.settle(current.dispatchId, current.revision, { state: 'completed', reply: 'done' }), current);
  assert.throws(() => store.settle(current.dispatchId, current.revision, { state: 'failed', error: 'late' }), /settlement conflict/);
});

test('legacy registry migrates in place; service and invocation adapter share one authority across restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-migration-'));
  try {
    const file = join(root, 'sessions.json');
    const legacy = createHostPersistence({ defaultModelProfileId: 'profile' });
    const session = legacy.sessions.register('pet', 'pet:12345678', true);
    writeFileSync(file, JSON.stringify({ version: 2, activeSessionIds: { pet: session.id }, sessions: { [session.id]: {
      ...session, modelProfileId: undefined, requiredInputModalities: undefined,
    } } }));
    const persistence = createFileHostPersistence(file, 'profile');
    const service = new ServerTuiSessionService({ runtimeConfig: buildHostRuntimeConfig(root), persistence, defaultModelProfileId: 'profile' });
    assert.equal(service.getActiveSession('pet').id, session.id);
    assert.equal(service.getChatThreadId('pet'), session.threadId);
    const { input } = admitted(persistence);
    service.selectModelProfile('pet', session.id, 'second');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.version, 4);
    assert.equal(raw.hostPersistenceVersion, 1);
    assert.equal(raw.invocations[input.dispatchId].sessionId, session.id);
    assert.equal(raw.sessions[session.id].modelProfileId, 'second');
    const reopened = createFileHostPersistence(file, 'profile');
    assert.equal(reopened.invocations.read(input.dispatchId)?.scope?.id, 'a');
    assert.equal(reopened.sessions.active('pet')?.modelProfileId, 'second');
    assert.equal(reopened.sessions.list().length, 1);
    writeFileSync(file, '{broken');
    assert.throws(() => createFileHostPersistence(file, 'profile'));
    assert.throws(() => persistence.sessions.updateProfile(session.id, 'lost'), /single writer/);
    assert.equal(persistence.sessions.read(session.id)?.modelProfileId, 'second');
    assert.equal(readFileSync(file, 'utf8'), '{broken');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('session identity conflicts and removal of unresolved invocation fail closed', () => {
  const { p, session } = admitted();
  assert.throws(() => p.sessions.register('other', session.id, true), /another Pet/);
  assert.throws(() => p.sessions.remove(session.id), /unresolved/);
  const detached = p.sessions.read(session.id)!;
  detached.threadId = 'tampered';
  assert.equal(p.sessions.read(session.id)?.threadId, session.threadId);
});

test('compatibility session writes preserve invocation facts and refuse orphaning them', async () => {
  const { saveTuiSessionState, loadTuiSessionState } = await import('../session/tuiSessionRegistry');
  const root = mkdtempSync(join(tmpdir(), 'host-legacy-facade-'));
  try {
    const file = join(root, 'registry.json');
    const { input } = admitted(createFileHostPersistence(file, 'profile'));
    const registry = loadTuiSessionState('profile', file);
    saveTuiSessionState(registry, file);
    assert.equal(createFileHostPersistence(file, 'profile').invocations.read(input.dispatchId)?.dispatchId, input.dispatchId);
    delete registry.sessions[input.sessionId];
    assert.throws(() => saveTuiSessionState(registry, file), /orphan/);
    assert.ok(createFileHostPersistence(file, 'profile').sessions.read(input.sessionId));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only unstarted legacy calls can persist active-session selection at dequeue', () => {
  const p = createHostPersistence({ defaultModelProfileId: 'profile' });
  const first = p.sessions.create('pet');
  const next = p.sessions.create('pet');
  let record = p.invocations.admit({ dispatchId: 'legacy', petId: 'pet', sessionId: first.id,
    threadId: first.threadId, request: 'legacy', fingerprint: 'legacy' }).record;
  record = p.invocations.bindLegacyQueuedSession(record.dispatchId, record.revision, next.id);
  assert.equal(record.threadId, next.threadId);
  record = p.invocations.claimStart(record.dispatchId, record.revision, 'start');
  assert.throws(() => p.invocations.bindLegacyQueuedSession(record.dispatchId, record.revision, first.id), /conflict/);
  const { record: scoped } = admitted(p);
  assert.throws(() => p.invocations.bindLegacyQueuedSession(scoped.dispatchId, scoped.revision, next.id), /legacy/);
});
