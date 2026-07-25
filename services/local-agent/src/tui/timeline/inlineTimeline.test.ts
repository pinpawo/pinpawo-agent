import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalAgentTimelineEntry } from '../../localAgentSession';
import {
  advanceInlineTimeline,
  isTimelineEntrySettled,
  partitionInlineTimeline,
} from './inlineTimeline';

function message(
  id: string,
  status: 'streaming' | 'completed',
): LocalAgentTimelineEntry {
  return {
    id,
    type: 'message',
    role: 'assistant',
    text: id,
    status,
  };
}

function operation(
  id: string,
  phase: 'started' | 'updated' | 'completed' | 'failed' | 'interrupted',
): LocalAgentTimelineEntry {
  return {
    id,
    type: 'operation',
    requestId: 'request-1',
    operationKey: id,
    kind: 'tool',
    title: id,
    phase,
  };
}

test('partitionInlineTimeline commits the entire settled timeline', () => {
  const entries = [
    message('user', 'completed'),
    operation('tool', 'completed'),
    message('assistant', 'completed'),
  ];

  assert.deepEqual(partitionInlineTimeline(entries), {
    committedEntries: entries,
    liveEntries: [],
  });
});

test('partitionInlineTimeline keeps the first mutable entry and everything after it live', () => {
  const entries = [
    message('user', 'completed'),
    operation('tool-a', 'completed'),
    operation('tool-b', 'updated'),
    message('subagent', 'completed'),
    message('assistant', 'streaming'),
  ];

  assert.deepEqual(partitionInlineTimeline(entries), {
    committedEntries: entries.slice(0, 2),
    liveEntries: entries.slice(2),
  });
});

test('terminal operation phases are settled', () => {
  assert.equal(isTimelineEntrySettled(operation('completed', 'completed')), true);
  assert.equal(isTimelineEntrySettled(operation('failed', 'failed')), true);
  assert.equal(isTimelineEntrySettled(operation('interrupted', 'interrupted')), true);
  assert.equal(isTimelineEntrySettled(operation('started', 'started')), false);
  assert.equal(isTimelineEntrySettled(operation('updated', 'updated')), false);
});

test('advanceInlineTimeline keeps a monotonic Static ledger across shorter snapshots', () => {
  const firstProjection = [
    message('user-1', 'completed'),
    operation('tool-1', 'completed'),
    message('assistant-1', 'completed'),
  ];
  const first = advanceInlineTimeline([], firstProjection);

  const shorterSnapshot = [
    message('user-1', 'completed'),
    message('assistant-1', 'completed'),
  ];
  const afterSnapshot = advanceInlineTimeline(first.committedEntries, shorterSnapshot);

  const nextProjection = [
    ...shorterSnapshot,
    message('user-2', 'completed'),
    message('assistant-2', 'streaming'),
  ];
  const next = advanceInlineTimeline(afterSnapshot.committedEntries, nextProjection);

  assert.deepEqual(
    next.committedEntries.map((entry) => entry.id),
    ['user-1', 'tool-1', 'assistant-1', 'user-2'],
  );
  assert.deepEqual(
    next.liveEntries.map((entry) => entry.id),
    ['assistant-2'],
  );
});
