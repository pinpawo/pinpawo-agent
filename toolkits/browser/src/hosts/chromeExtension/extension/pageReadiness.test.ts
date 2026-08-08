import assert from 'node:assert/strict';
import test from 'node:test';
import { pageReadinessEvents } from './pageReadiness';

test('emits document.ready and dom.changed with text data for a loaded body', () => {
  const events = pageReadinessEvents(
    { textLength: 42, url: 'https://example.com/', text: 'hello world' },
    7,
    'https://example.com/',
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'document.ready');
  assert.equal(events[0].payload.readyState, 'complete');
  assert.equal(events[1].event, 'dom.changed');
  assert.deepEqual(events[1].payload, { textLength: 42, textRevision: 1 });
});

test('a zero-length body still reports document.ready but no dom.changed', () => {
  const events = pageReadinessEvents(
    { textLength: 0, url: 'https://example.com/', text: '' },
    7,
    'https://example.com/',
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'document.ready');
});

test('negative or missing textLength is coerced to 0 and suppressed body event', () => {
  const noLength = pageReadinessEvents({ url: 'https://example.com/' }, 7, 'https://example.com/');
  assert.equal(noLength.length, 1);
  assert.equal(noLength[0].event, 'document.ready');

  const neg = pageReadinessEvents({ textLength: -5, url: 'https://example.com/' }, 7, 'https://example.com/');
  assert.equal(neg.length, 1);
  assert.equal(neg[0].event, 'document.ready');
});

test('revision is clamped to a positive integer and defaults to 1', () => {
  const events = pageReadinessEvents({ textLength: 5, url: 'https://e.com/' }, 1, 'https://e.com/', 0);
  assert.equal(events[1].payload.textRevision, 1);
  const events2 = pageReadinessEvents({ textLength: 5, url: 'https://e.com/' }, 1, 'https://e.com/', 9);
  assert.equal(events2[1].payload.textRevision, 9);
});

test('returns no events for a missing tab id or url', () => {
  assert.deepEqual(pageReadinessEvents({ textLength: 5, url: 'https://e.com/' }, 0, 'https://e.com/'), []);
  assert.deepEqual(pageReadinessEvents({ textLength: 5, url: 'https://e.com/' }, 7, ''), []);
  assert.deepEqual(pageReadinessEvents({ textLength: 5 }, 7, undefined as unknown as string), []);
});
