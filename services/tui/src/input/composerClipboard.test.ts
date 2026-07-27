import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyClipboardAction,
  resolveClipboardAction,
} from './composerClipboard';

test('clipboard shortcuts recognize Cmd and Ctrl+Shift copy/cut', () => {
  assert.equal(resolveClipboardAction({
    name: 'c',
    super: true,
  }), 'copy');
  assert.equal(resolveClipboardAction({
    name: 'x',
    ctrl: true,
    shift: true,
  }), 'cut');
  assert.equal(resolveClipboardAction({
    name: 'c',
    ctrl: true,
  }), null);
  assert.equal(resolveClipboardAction({
    name: 'v',
    super: true,
  }), null);
});

test('clipboard cut deletes only after a successful copy', () => {
  let deleted = 0;
  const editor = {
    hasSelection: () => true,
    getSelectedText: () => 'selected',
    deleteSelection: () => {
      deleted += 1;
      return true;
    },
  };
  assert.deepEqual(applyClipboardAction({
    action: 'cut',
    editor,
    copy: () => false,
  }), {
    handled: true,
    copied: false,
    cut: false,
  });
  assert.equal(deleted, 0);

  assert.deepEqual(applyClipboardAction({
    action: 'cut',
    editor,
    copy: (text) => text === 'selected',
  }), {
    handled: true,
    copied: true,
    cut: true,
  });
  assert.equal(deleted, 1);
});

test('clipboard cut reports a copy when selection deletion fails', () => {
  assert.deepEqual(applyClipboardAction({
    action: 'cut',
    editor: {
      hasSelection: () => true,
      getSelectedText: () => 'selected',
      deleteSelection: () => false,
    },
    copy: () => true,
  }), {
    handled: true,
    copied: true,
    cut: false,
  });
});

test('clipboard action yields when there is no internal selection', () => {
  assert.deepEqual(applyClipboardAction({
    action: 'copy',
    editor: {
      hasSelection: () => false,
      getSelectedText: () => '',
      deleteSelection: () => false,
    },
    copy: () => true,
  }), {
    handled: false,
    copied: false,
    cut: false,
  });
});
