import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createTuiSession,
  ensureActiveTuiSession,
  listTuiSessions,
  loadTuiSessionState,
  resumeTuiSession,
  saveTuiSessionState,
  updateTuiSessionSummary,
} from './tuiSessionRegistry';

test('tui session registry creates, lists, and resumes sessions without deleting old records', () => {
  const state = loadTuiSessionState('/path/that/does/not/exist.json');
  const first = ensureActiveTuiSession(state, 'pet-a', new Date('2026-06-01T01:00:00.000Z'));
  updateTuiSessionSummary(state, first.id, {
    title: 'first chat',
    messageCount: 2,
    updatedAt: '2026-06-01T01:01:00.000Z',
  });
  const second = createTuiSession(state, 'pet-a', new Date('2026-06-01T02:00:00.000Z'));

  assert.equal(state.activeSessionIds['pet-a'], second.id);
  assert.equal(Object.keys(state.sessions).length, 2);

  const resumed = resumeTuiSession(state, 'pet-a', first.id);
  assert.equal(resumed?.id, first.id);
  assert.equal(state.activeSessionIds['pet-a'], first.id);
  assert.deepEqual(listTuiSessions(state, 'pet-a').map((session) => [session.id, session.active]), [
    [second.id, false],
    [first.id, true],
  ]);
});

test('tui session registry rejects unversioned and unsupported persisted state', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pinpawo-tui-sessions-'));
  const filePath = path.join(tmp, 'tui-sessions.json');
  const unsupportedStates = [
    { 'pet-a': 'abc12345' },
    { version: 1, activeSessionIds: {}, sessions: {} },
    { version: 3, activeSessionIds: {}, sessions: {} },
  ];

  for (const persisted of unsupportedStates) {
    await writeFile(filePath, JSON.stringify(persisted), 'utf8');
    assert.deepEqual(loadTuiSessionState(filePath), {
      version: 2,
      activeSessionIds: {},
      sessions: {},
    });
  }
});

test('tui session registry drops non-canonical current records', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pinpawo-tui-sessions-'));
  const filePath = path.join(tmp, 'tui-sessions.json');
  const sessionId = 'pet-a:abc12345';
  const currentRecord = {
    id: sessionId,
    petId: 'pet-a',
    suffix: 'abc12345',
    threadId: 'petbot:tui:pet:pet-a:abc12345',
    title: 'Current session',
    messageCount: 1,
    createdAt: '2026-06-01T01:00:00.000Z',
    updatedAt: '2026-06-01T01:01:00.000Z',
  };
  const invalidRecords = [
    { ...currentRecord, id: undefined },
    { ...currentRecord, id: 'pet-a:different' },
    { ...currentRecord, threadId: undefined },
    { ...currentRecord, threadId: 'wrong-thread' },
    { ...currentRecord, title: undefined },
    { ...currentRecord, messageCount: undefined },
    { ...currentRecord, messageCount: -1 },
    { ...currentRecord, messageCount: 1.5 },
  ];

  for (const record of invalidRecords) {
    await writeFile(filePath, JSON.stringify({
      version: 2,
      activeSessionIds: { 'pet-a': sessionId },
      sessions: { [sessionId]: record },
    }), 'utf8');
    assert.deepEqual(loadTuiSessionState(filePath), {
      version: 2,
      activeSessionIds: {},
      sessions: {},
    });
  }
});

test('tui session registry persists versioned state', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pinpawo-tui-sessions-'));
  const filePath = path.join(tmp, 'tui-sessions.json');
  const state = loadTuiSessionState('/missing.json');
  const session = ensureActiveTuiSession(state, 'pet-a', new Date('2026-06-01T01:00:00.000Z'));
  updateTuiSessionSummary(state, session.id, { title: 'persisted', messageCount: 3 });

  saveTuiSessionState(state, filePath);
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as { version?: number };
  const restored = loadTuiSessionState(filePath);

  assert.equal(raw.version, 2);
  assert.equal(restored.sessions[session.id]?.title, 'persisted');
  assert.equal(restored.sessions[session.id]?.messageCount, 3);
});
