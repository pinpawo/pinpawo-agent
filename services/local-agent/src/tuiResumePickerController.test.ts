import assert from 'node:assert/strict';
import test from 'node:test';
import { moveResumeSelectionIndex } from './tui/useResumePickerController';

test('moveResumeSelectionIndex keeps resume picker selection inside bounds', () => {
  assert.equal(moveResumeSelectionIndex(0, 3, -1), 0);
  assert.equal(moveResumeSelectionIndex(0, 3, 1), 1);
  assert.equal(moveResumeSelectionIndex(1, 3, 1), 2);
  assert.equal(moveResumeSelectionIndex(2, 3, 1), 2);
  assert.equal(moveResumeSelectionIndex(0, 0, 1), 0);
});
