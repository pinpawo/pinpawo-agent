import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateComposerLayout } from './composerLayout';

test('composer grows by reclaiming auxiliary footer rows', () => {
  assert.deepEqual(calculateComposerLayout('one', 1), {
    visibleContentRows: 3,
    frameHeight: 5,
    headerHeight: 1,
    liveHeight: 1,
  });
  assert.deepEqual(calculateComposerLayout('one\ntwo', 1), {
    visibleContentRows: 4,
    frameHeight: 6,
    headerHeight: 0,
    liveHeight: 1,
  });
  assert.deepEqual(calculateComposerLayout('one\ntwo\nthree', 1), {
    visibleContentRows: 5,
    frameHeight: 7,
    headerHeight: 0,
    liveHeight: 0,
  });
});

test('composer caps soft-wrapped content without resizing the terminal footer', () => {
  assert.deepEqual(calculateComposerLayout('wrapped text', 20), {
    visibleContentRows: 5,
    frameHeight: 7,
    headerHeight: 0,
    liveHeight: 0,
  });
});
