import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TextareaRenderable,
  TextAttributes,
} from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import {
  ComposerDecorationController,
  createComposerDecorationStyle,
  refreshComposerDecorations,
} from './composerDecorations';
import { placeComposerCursorAtTextOffset } from './composerTextPosition';

test('composer decorations render without changing rich input source', async (context) => {
  const setup = await createTestRenderer({
    width: 40,
    height: 8,
    kittyKeyboard: true,
  });
  const style = createComposerDecorationStyle();
  context.after(() => {
    style.destroy();
    setup.renderer.destroy();
  });
  const textarea = new TextareaRenderable(setup.renderer, {
    id: 'decorated-composer',
    width: 40,
    height: 5,
    syntaxStyle: style,
    onContentChange: () => refreshComposerDecorations(textarea, style),
  });
  setup.renderer.root.add(textarea);
  textarea.focus();

  const source = [
    '# 标题 🙂',
    '你好🙂 `code` and **重点**',
    'Inspect @指南.md',
  ].join('\n');
  await setup.mockInput.pasteBracketedText(source);
  await setup.flush();

  assert.equal(textarea.plainText, source);
  assert.deepEqual(
    textarea.getLineHighlights(1).map((highlight) => ({
      start: highlight.start,
      end: highlight.end,
    })),
    [{
      start: 7,
      end: 13,
    }, {
      start: 18,
      end: 26,
    }],
  );
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const codeSpan = spans.find((span) => span.text.includes('`code`'));
  assert.ok(codeSpan);
  assert.deepEqual(codeSpan.fg.toInts(), [105, 192, 200, 255]);
  const strongSpan = spans.find((span) => span.text.includes('**重点**'));
  assert.ok(strongSpan);
  assert.ok((strongSpan.attributes & TextAttributes.BOLD) !== 0);

  textarea.undo();
  await setup.flush();
  assert.equal(textarea.plainText, '');
  textarea.redo();
  await setup.flush();
  assert.equal(textarea.plainText, source);
});

test('completed file mention decoration keeps a path with spaces stable', async (context) => {
  const setup = await createTestRenderer({
    width: 60,
    height: 6,
    kittyKeyboard: true,
  });
  const style = createComposerDecorationStyle();
  const textarea = new TextareaRenderable(setup.renderer, {
    id: 'file-mention-decoration',
    width: 60,
    height: 3,
    syntaxStyle: style,
  });
  const decorations = new ComposerDecorationController(textarea, style);
  context.after(() => {
    decorations.destroy();
    style.destroy();
    setup.renderer.destroy();
  });
  textarea.onContentChange = () => decorations.scheduleRefresh();
  setup.renderer.root.add(textarea);
  textarea.focus();

  const text = 'Inspect @指南 文档.md carefully.';
  const mentionEnd = 'Inspect @指南 文档.md'.length;
  textarea.replaceText(text);
  decorations.addCompletedFileMention({
    text,
    cursorOffset: mentionEnd + 1,
    mention: {
      start: 'Inspect '.length,
      end: mentionEnd,
      path: '指南 文档.md',
    },
  });
  const completedExtmarks = decorations.completedFileMentions;
  assert.equal(completedExtmarks.length, 1);
  assert.equal(
    textarea.getTextRange(
      completedExtmarks[0]!.start,
      completedExtmarks[0]!.end,
    ),
    '@指南 文档.md',
  );
  await setup.flush();

  assert.equal(textarea.plainText, text);
  const completedHighlights = textarea.getLineHighlights(0);
  assert.ok(completedHighlights.some((highlight) => (
    highlight.priority === 50
    && highlight.start === 'Inspect '.length
    && highlight.end === 21
  )), JSON.stringify(completedHighlights));

  textarea.setCursor(0, 0);
  await setup.mockInput.typeText('Please ');
  await setup.flush();
  const editedText = `Please ${text}`;
  assert.equal(textarea.plainText, editedText);
  const editedExtmarks = decorations.completedFileMentions;
  assert.equal(editedExtmarks.length, 1);
  assert.equal(
    textarea.getTextRange(
      editedExtmarks[0]!.start,
      editedExtmarks[0]!.end,
    ),
    '@指南 文档.md',
  );
  assert.ok(textarea.getLineHighlights(0).some((highlight) => (
    highlight.priority === 50
    && highlight.start === 'Please Inspect '.length
    && highlight.end === 28
  )));

  placeComposerCursorAtTextOffset(
    textarea,
    textarea.plainText,
    'Please Inspect @指南'.length,
  );
  await setup.mockInput.typeText('新');
  await setup.flush();
  assert.equal(
    textarea.plainText,
    'Please Inspect @指南新 文档.md carefully.',
  );
  assert.equal(decorations.completedFileMentions.length, 0);

  textarea.undo();
  await setup.flush();
  assert.equal(textarea.plainText, editedText);
  assert.equal(decorations.completedFileMentions.length, 1);

  textarea.setCursor(0, 'Please Inspect '.length);
  setup.mockInput.pressKey('DELETE');
  await setup.flush();
  assert.equal(textarea.plainText, 'Please Inspect 指南 文档.md carefully.');
  assert.equal(
    decorations.completedFileMentions.length,
    0,
  );

  textarea.undo();
  assert.equal(
    decorations.completedFileMentions.length,
    1,
  );
  await setup.flush();
  assert.equal(textarea.plainText, editedText);
  assert.equal(
    decorations.completedFileMentions.length,
    1,
  );

  textarea.redo();
  await setup.flush();
  assert.equal(textarea.plainText, 'Please Inspect 指南 文档.md carefully.');
  assert.equal(
    decorations.completedFileMentions.length,
    0,
  );

  textarea.undo();
  await setup.flush();
  assert.equal(textarea.plainText, editedText);
  const restoredMention = decorations.completedFileMentions[0]!;
  textarea.setSelection(restoredMention.start, restoredMention.end);
  assert.equal(textarea.deleteSelection(), true);
  await setup.flush();
  assert.equal(textarea.plainText, 'Please Inspect  carefully.');
  assert.equal(decorations.completedFileMentions.length, 0);

  textarea.undo();
  await setup.flush();
  assert.equal(textarea.plainText, editedText);
  assert.equal(decorations.completedFileMentions.length, 1);

  textarea.redo();
  await setup.flush();
  assert.equal(textarea.plainText, 'Please Inspect  carefully.');
  assert.equal(decorations.completedFileMentions.length, 0);
});
