import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentTimelineEntriesFromSnapshot,
  buildTuiSessionSnapshotFromHistory,
  historyFromSnapshotTimeline,
  timelineSnapshotFromHistory,
} from './tuiSessionSnapshot';

test('CORE-4 snapshot adapter converts legacy history into checkpoint timeline messages', () => {
  const snapshot = buildTuiSessionSnapshotFromHistory({
    sessionId: 'chat:pet',
    kind: 'chat',
    history: [
      { id: 'user-1', kind: 'user', text: 'hello', timestamp: '10:00:00' },
      { id: 'system-1', kind: 'system', text: 'connected' },
      { id: 'assistant-1', kind: 'assistant', text: 'hi' },
    ],
    runtime: {
      model: 'gpt-test',
      cwd: '/tmp/work',
      stateRoot: '/tmp/work/.pinpawo',
      contextWindow: 1000,
    },
  });

  assert.equal(snapshot.sessionId, 'chat:pet');
  assert.deepEqual(snapshot.timeline.map((entry) => [entry.id, entry.type, entry.source]), [
    ['history:user-1', 'message', 'checkpoint'],
    ['history:assistant-1', 'message', 'checkpoint'],
  ]);
  assert.deepEqual(historyFromSnapshotTimeline(snapshot.timeline).map((cell) => [cell.kind, cell.text]), [
    ['user', 'hello'],
    ['assistant', 'hi'],
  ]);
  assert.deepEqual(snapshot.runtime, {
    model: 'gpt-test',
    cwd: '/tmp/work',
    stateRoot: '/tmp/work/.pinpawo',
    contextWindow: 1000,
  });
});

test('CORE-4 snapshot adapter projects snapshot timeline into current UI timeline entries', () => {
  const timeline = timelineSnapshotFromHistory([
    { id: 'user-1', kind: 'user', text: 'hello' },
  ]);
  const entries = agentTimelineEntriesFromSnapshot([
    ...timeline,
    {
      id: 'req-1:operation:tool',
      type: 'operation',
      requestId: 'req-1',
      operationKey: 'tool',
      phase: 'completed',
      source: 'checkpoint',
      title: 'Run tool',
      summary: 'done',
      startedAt: 10,
      updatedAt: 20,
      completedAt: 20,
    },
  ]);

  assert.deepEqual(entries.map((entry) => [entry.id, entry.type]), [
    ['history:user-1', 'message'],
    ['req-1:operation:tool', 'operation'],
  ]);
  assert.equal(entries[1]?.type === 'operation' ? entries[1].title : undefined, 'Run tool');
});
