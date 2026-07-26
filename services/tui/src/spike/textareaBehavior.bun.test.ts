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
