import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateComposerLayout } from './composerLayout';

test('composer grows for logical lines and preserves frame chrome', () => {
  assert.deepEqual(calculateComposerLayout('one\ntwo\nthree', 1), {
    contentRows: 3,
    frameHeight: 7,
    footerHeight: 10,
  });
});

test('composer grows for soft-wrapped visual lines and remains bounded', () => {
  assert.deepEqual(calculateComposerLayout('wrapped text', 4), {
    contentRows: 4,
    frameHeight: 8,
    footerHeight: 11,
  });
  assert.deepEqual(calculateComposerLayout('many lines', 20), {
    contentRows: 8,
    frameHeight: 12,
    footerHeight: 15,
  });
});
