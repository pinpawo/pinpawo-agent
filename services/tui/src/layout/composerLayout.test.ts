import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateComposerLayout } from './composerLayout';

test('composer grows the split footer while keeping live activity visible', () => {
  assert.deepEqual(calculateComposerLayout('one', 1), {
    visibleContentRows: 4,
    frameHeight: 6,
    headerHeight: 0,
    liveHeight: 1,
    statusHeight: 2,
    footerHeight: 9,
  });
  assert.deepEqual(calculateComposerLayout('one\ntwo', 1), {
    visibleContentRows: 4,
    frameHeight: 6,
    headerHeight: 0,
    liveHeight: 1,
    statusHeight: 2,
    footerHeight: 9,
  });
  assert.deepEqual(calculateComposerLayout('one\ntwo\nthree', 1), {
    visibleContentRows: 5,
    frameHeight: 7,
    headerHeight: 0,
    liveHeight: 1,
    statusHeight: 2,
    footerHeight: 10,
  });
});

test('composer caps soft-wrapped content and its dynamic footer', () => {
  assert.deepEqual(calculateComposerLayout('wrapped text', 20), {
    visibleContentRows: 5,
    frameHeight: 7,
    headerHeight: 0,
    liveHeight: 1,
    statusHeight: 2,
    footerHeight: 10,
  });
});

test('composer reserves a persistent attachment header', () => {
  assert.deepEqual(calculateComposerLayout('one', 1, { persistentHeader: true }), {
    visibleContentRows: 3,
    frameHeight: 5,
    headerHeight: 1,
    liveHeight: 1,
    statusHeight: 2,
    footerHeight: 9,
  });
  assert.deepEqual(calculateComposerLayout('one\ntwo\nthree', 1, {
    persistentHeader: true,
  }), {
    visibleContentRows: 4,
    frameHeight: 6,
    headerHeight: 1,
    liveHeight: 1,
    statusHeight: 2,
    footerHeight: 10,
  });
});

test('command palette reclaims footer rows without changing footer height', () => {
  const layout = calculateComposerLayout('/', 1, {
    commandPalette: true,
  });
  assert.deepEqual(layout, {
    visibleContentRows: 1,
    frameHeight: 2,
    headerHeight: 5,
    liveHeight: 0,
    statusHeight: 2,
    footerHeight: 9,
  });
  assert.equal(
    layout.headerHeight + layout.liveHeight + layout.frameHeight + layout.statusHeight,
    9,
  );
});

test('composer layout reserves the adaptive current-plan rows', () => {
  const layout = calculateComposerLayout('one', 1, { planHeight: 4 });
  assert.equal(layout.planHeight, 4);
  assert.equal(layout.footerHeight, 13);
});
