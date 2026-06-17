import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTextAreaControllerCommand,
  buildTextAreaComposerProps,
  measureTextAreaControllerLayout,
} from './useTextAreaController';

test('buildTextAreaComposerProps maps textarea input to composer props', () => {
  assert.deepEqual(
    buildTextAreaComposerProps(
      { text: 'hello', cursorOffset: 2 },
      { focused: true, placeholder: '输入消息', width: 24 },
    ),
    {
      value: 'hello',
      cursorOffset: 2,
      placeholder: '输入消息',
      focus: true,
      width: 24,
    },
  );
});

test('applyTextAreaControllerCommand applies textarea command with host width', () => {
  assert.deepEqual(
    applyTextAreaControllerCommand(
      { text: 'abcdef', cursorOffset: 1 },
      { type: 'moveDown' },
      3,
    ),
    { text: 'abcdef', cursorOffset: 4 },
  );
});

test('measureTextAreaControllerLayout exposes visual cursor boundaries', () => {
  assert.deepEqual(
    measureTextAreaControllerLayout({ text: 'abcdef', cursorOffset: 1 }, 3).cursor,
    {
      offset: 1,
      rowIndex: 0,
      column: 1,
      isAtFirstVisualRow: true,
      isAtLastVisualRow: false,
    },
  );
  assert.deepEqual(
    measureTextAreaControllerLayout({ text: 'abcdef', cursorOffset: 4 }, 3).cursor,
    {
      offset: 4,
      rowIndex: 1,
      column: 1,
      isAtFirstVisualRow: false,
      isAtLastVisualRow: true,
    },
  );
});
