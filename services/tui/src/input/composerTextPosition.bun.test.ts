import assert from 'node:assert/strict';
import test from 'node:test';
import { TextareaRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import {
  completeFileMention,
  createFileMentionState,
  syncFileMention,
} from './fileMention';
import {
  placeComposerCursorAtTextOffset,
  readComposerTextInput,
} from './composerTextPosition';

test('file completion maps terminal-cell cursors to text offsets with wide characters', async (context) => {
  const setup = await createTestRenderer({
    width: 60,
    height: 12,
  });
  context.after(() => setup.renderer.destroy());
  const textarea = new TextareaRenderable(setup.renderer, {
    width: 60,
    height: 4,
  });
  setup.renderer.root.add(textarea);
  textarea.setText('中文 @docs/TUI.md suffix');
  textarea.setCursor(0, 7);

  const input = readComposerTextInput(textarea);
  assert.deepEqual(input, {
    text: '中文 @docs/TUI.md suffix',
    cursorOffset: '中文 @d'.length,
  });
  const state = syncFileMention(
    createFileMentionState(),
    input,
    process.cwd(),
    true,
  );
  assert.equal(state.phase, 'open');
  if (state.phase !== 'open') return;
  const completion = completeFileMention(input, {
    ...state,
    items: [{ path: 'docs/', type: 'directory' }],
  });
  assert.deepEqual(completion, {
    text: '中文 @docs/ suffix',
    cursorOffset: '中文 @docs/'.length,
  });
  if (!completion) return;

  textarea.replaceText(completion.text);
  placeComposerCursorAtTextOffset(
    textarea,
    completion.text,
    completion.cursorOffset,
  );
  assert.equal(
    textarea.getTextRange(0, textarea.cursorOffset),
    '中文 @docs/',
  );
  textarea.undo();
  assert.equal(textarea.plainText, '中文 @docs/TUI.md suffix');
});
