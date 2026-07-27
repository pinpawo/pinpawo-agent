import assert from 'node:assert/strict';
import test from 'node:test';
import { TextareaRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { installSingleGraphemeBackspaceWorkaround } from './textareaWorkarounds';

test('textarea preserves pasted lines and deletes across line boundaries', async (context) => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
  });
  context.after(() => setup.renderer.destroy());

  const textarea = new TextareaRenderable(setup.renderer, {
    id: 'textarea-behavior',
    width: 80,
    height: 4,
  });
  setup.renderer.root.add(textarea);
  installSingleGraphemeBackspaceWorkaround(textarea);
  textarea.focus();

  await setup.mockInput.pasteBracketedText('one\ntwo\nthree');
  await setup.flush();
  assert.equal(textarea.plainText, 'one\ntwo\nthree');
  assert.equal(textarea.lineCount, 3);

  for (const expected of [
    'one\ntwo\nthre',
    'one\ntwo\nthr',
    'one\ntwo\nth',
    'one\ntwo\nt',
    'one\ntwo\n',
    'one\ntwo',
  ]) {
    setup.mockInput.pressBackspace();
    await setup.flush();
    assert.equal(textarea.plainText, expected);
  }
  assert.equal(textarea.lineCount, 2);

  setup.mockInput.pressEnter();
  await setup.mockInput.typeText('next');
  await setup.flush();
  assert.equal(textarea.plainText, 'one\ntwo\nnext');
  assert.equal(textarea.lineCount, 3);

  textarea.setText('one\n🙂');
  textarea.gotoBufferEnd();
  setup.mockInput.pressBackspace();
  await setup.flush();
  assert.equal(textarea.plainText, 'one\n');
  assert.equal(textarea.lineCount, 2);

  textarea.undo();
  await setup.flush();
  assert.equal(textarea.plainText, 'one\n🙂');

  textarea.setText('one\nx\nthree');
  textarea.setCursor(1, 1);
  setup.mockInput.pressBackspace();
  await setup.flush();
  assert.equal(textarea.plainText, 'one\n\nthree');

  textarea.undo();
  await setup.flush();
  assert.equal(textarea.plainText, 'one\nx\nthree');
});

test('textarea supports macOS selection, word movement, and undo/redo', async (context) => {
  const setup = await createTestRenderer({
    width: 80,
    height: 24,
    kittyKeyboard: true,
  });
  context.after(() => setup.renderer.destroy());

  const textarea = new TextareaRenderable(setup.renderer, {
    id: 'textarea-shortcuts',
    width: 80,
    height: 4,
  });
  setup.renderer.root.add(textarea);
  textarea.focus();
  textarea.setText('alpha beta\n你好🙂 gamma');
  textarea.gotoBufferEnd();

  setup.mockInput.pressArrow('left', { meta: true });
  await setup.flush();
  assert.equal(textarea.cursorOffset, 18);

  setup.mockInput.pressArrow('left', {
    meta: true,
    shift: true,
  });
  await setup.flush();
  assert.equal(textarea.getSelectedText(), '\n你好🙂 g');

  setup.mockInput.pressBackspace();
  await setup.flush();
  assert.equal(textarea.plainText, 'alpha betaamma');

  setup.mockInput.pressKey('z', { super: true });
  await setup.flush();
  assert.equal(textarea.plainText, 'alpha beta\n你好🙂 gamma');

  setup.mockInput.pressKey('z', {
    super: true,
    shift: true,
  });
  await setup.flush();
  assert.equal(textarea.plainText, 'alpha betaamma');

  textarea.setText('one\ntwo\nthree');
  textarea.setCursor(1, 2);
  setup.mockInput.pressKey('a', { ctrl: true });
  await setup.flush();
  assert.deepEqual(textarea.logicalCursor, {
    row: 1,
    col: 0,
    offset: 4,
  });
  setup.mockInput.pressKey('e', { ctrl: true });
  await setup.flush();
  assert.deepEqual(textarea.logicalCursor, {
    row: 1,
    col: 3,
    offset: 7,
  });

  setup.mockInput.pressKey('HOME');
  await setup.flush();
  assert.equal(textarea.cursorOffset, 0);
  setup.mockInput.pressKey('END');
  await setup.flush();
  assert.equal(textarea.cursorOffset, 13);

  setup.mockInput.pressKey('a', { super: true });
  await setup.flush();
  assert.equal(textarea.getSelectedText(), 'one\ntwo\nthree');
  await setup.mockInput.typeText('replacement');
  await setup.flush();
  assert.equal(textarea.plainText, 'replacement');
});
