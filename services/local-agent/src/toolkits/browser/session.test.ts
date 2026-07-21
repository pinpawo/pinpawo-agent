import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBrowserExtractPayload,
  buildBrowserSnapshotPayload,
} from './session';

test('browser snapshot payload returns more than 10000 characters when within the preview cap', () => {
  const text = 'x'.repeat(10_050);
  const snapshot = buildBrowserSnapshotPayload({
    title: 'Long page',
    url: 'https://example.com/long',
    text,
    interactive: [{
      index: 1,
      tag: 'a',
      text: 'first',
      type: null,
      placeholder: null,
      hint: 'text=first',
    }],
    interactiveCount: 3,
  });

  assert.equal(snapshot.textLength, 10_050);
  assert.equal(snapshot.returnedTextLength, 10_050);
  assert.equal(snapshot.text.length, 10_050);
  assert.equal(snapshot.textLimit, 50_000);
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.hasMore, false);
  assert.equal(snapshot.nextTextOffset, null);
  assert.equal(snapshot.interactiveCount, 3);
  assert.equal(snapshot.returnedInteractiveCount, 1);
  assert.equal(snapshot.interactiveTruncated, true);
  assert.ok(
    Object.keys(snapshot).indexOf('interactive') < Object.keys(snapshot).indexOf('text'),
    'interactive hints should appear before large text previews',
  );
});

test('browser snapshot payload exposes truncation metadata beyond the preview cap', () => {
  const text = 'x'.repeat(50_050);
  const snapshot = buildBrowserSnapshotPayload({
    title: 'Very long page',
    url: 'https://example.com/very-long',
    text,
    interactive: [],
  });

  assert.equal(snapshot.textLength, 50_050);
  assert.equal(snapshot.returnedTextLength, 50_000);
  assert.equal(snapshot.text.length, 50_000);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.hasMore, true);
  assert.equal(snapshot.nextTextOffset, 50_000);
});

test('browser extract payload chunks full page text by offset and limit', () => {
  const first = buildBrowserExtractPayload({
    title: 'Chunked page',
    url: 'https://example.com/chunked',
    text: '0123456789',
    offset: 3,
    limit: 4,
  });

  assert.equal(first.text, '3456');
  assert.equal(first.textLength, 10);
  assert.equal(first.returnedTextLength, 4);
  assert.equal(first.offset, 3);
  assert.equal(first.textEndOffset, 7);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 7);

  const second = buildBrowserExtractPayload({
    title: 'Chunked page',
    url: 'https://example.com/chunked',
    text: '0123456789',
    offset: first.nextOffset ?? 0,
    limit: 4,
  });

  assert.equal(second.text, '789');
  assert.equal(second.returnedTextLength, 3);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextOffset, null);
});

test('browser extract payload defaults to 50000 character chunks and validates limits', () => {
  const payload = buildBrowserExtractPayload({
    title: 'Default chunk',
    url: 'https://example.com/default',
    text: 'a'.repeat(50_001),
  });

  assert.equal(payload.returnedTextLength, 50_000);
  assert.equal(payload.hasMore, true);
  assert.equal(payload.nextOffset, 50_000);

  assert.throws(
    () => buildBrowserExtractPayload({
      title: 'Too much',
      url: 'https://example.com/too-much',
      text: 'abc',
      limit: 100_001,
    }),
    /limit must be an integer between 1 and 100000/,
  );
});
