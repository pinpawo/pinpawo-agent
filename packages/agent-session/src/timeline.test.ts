import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pageAgentTimeline,
  windowAgentTimeline,
  type AgentTimelineEntry,
} from './index';

const entries = (count: number): AgentTimelineEntry[] => Array.from({ length: count }, (_, index) => ({
  id: `m-${index}`,
  type: 'message',
  role: index % 2 ? 'assistant' : 'user',
  text: `message ${index}`,
  status: 'completed',
}));
const ids = (timeline: readonly AgentTimelineEntry[]) => timeline.map((entry) => entry.id);

test('a timeline window keeps the newest entries and counts the rest', () => {
  assert.deepEqual(windowAgentTimeline(entries(3), 5), { timeline: entries(3) });
  assert.deepEqual(windowAgentTimeline(entries(3), 3), { timeline: entries(3) });
  const window = windowAgentTimeline(entries(10), 3);
  assert.deepEqual(ids(window.timeline), ['m-7', 'm-8', 'm-9']);
  assert.deepEqual(window.timelineWindow, { omitted: 7 });
});

test('a timeline window reaches back to keep an open run whole', () => {
  const window = windowAgentTimeline(entries(10), 2, 5);
  assert.deepEqual(ids(window.timeline), ['m-5', 'm-6', 'm-7', 'm-8', 'm-9']);
  assert.deepEqual(window.timelineWindow, { omitted: 5 });
  // A run that already fits changes nothing.
  assert.deepEqual(ids(windowAgentTimeline(entries(10), 2, 9).timeline), ['m-8', 'm-9']);
  assert.deepEqual(windowAgentTimeline(entries(10), 2, 0), { timeline: entries(10) });
});

test('a timeline page ends just before its cursor', () => {
  const timeline = entries(10);
  assert.deepEqual(pageAgentTimeline(timeline, 'm-7', 3), { entries: timeline.slice(4, 7), omitted: 4 });
  assert.deepEqual(pageAgentTimeline(timeline, 'm-2', 3), { entries: timeline.slice(0, 2), omitted: 0 });
  assert.deepEqual(pageAgentTimeline(timeline, 'm-0', 3), { entries: [], omitted: 0 });
  // Compaction can rewrite the entry a reader still holds.
  assert.equal(pageAgentTimeline(timeline, 'gone', 3), null);
});
