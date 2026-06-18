import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expandTextAreaRangeToSegmentBoundaries,
  findNextTextAreaSegmentRange,
  findPreviousTextAreaSegmentRange,
} from './textSegments';

test('text segment helpers find previous and next grapheme ranges', () => {
  const text = '🙂a';

  assert.deepEqual(findPreviousTextAreaSegmentRange(text, 0), { start: 0, end: 0 });
  assert.deepEqual(findPreviousTextAreaSegmentRange(text, 1), { start: 0, end: 2 });
  assert.deepEqual(findPreviousTextAreaSegmentRange(text, 2), { start: 0, end: 2 });
  assert.deepEqual(findPreviousTextAreaSegmentRange(text, 3), { start: 2, end: 3 });

  assert.deepEqual(findNextTextAreaSegmentRange(text, 0), { start: 0, end: 2 });
  assert.deepEqual(findNextTextAreaSegmentRange(text, 1), { start: 0, end: 2 });
  assert.deepEqual(findNextTextAreaSegmentRange(text, 2), { start: 2, end: 3 });
  assert.deepEqual(findNextTextAreaSegmentRange(text, 3), { start: 3, end: 3 });
});

test('text segment helpers expand ranges to grapheme boundaries', () => {
  const text = '🙂a';

  assert.deepEqual(expandTextAreaRangeToSegmentBoundaries(text, 0, 1), { start: 0, end: 2 });
  assert.deepEqual(expandTextAreaRangeToSegmentBoundaries(text, 1, 3), { start: 0, end: 3 });
  assert.deepEqual(expandTextAreaRangeToSegmentBoundaries(text, 3, 1), { start: 0, end: 3 });
});
