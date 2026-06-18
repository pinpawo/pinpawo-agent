import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFileMentionModel,
  completeFileMentionInput,
  listFileMentionItems,
  moveFileMentionSelection,
} from './fileMention';

function fixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'pinpawo-file-mention-'));
  mkdirSync(path.join(root, 'docs'));
  mkdirSync(path.join(root, 'services'));
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'README.md'), 'hello\n');
  writeFileSync(path.join(root, 'docs', 'TUI.md'), 'doc\n');
  writeFileSync(path.join(root, 'docs', 'TEXTAREA.md'), 'textarea\n');
  writeFileSync(path.join(root, 'node_modules', 'ignored.js'), 'ignored\n');
  return root;
}

test('buildFileMentionModel opens for active @ path tokens', () => {
  const root = fixtureRoot();
  const model = buildFileMentionModel({ text: 'read @d', cursorOffset: 'read @d'.length }, root);

  assert.equal(model.open, true);
  assert.equal(model.query, 'd');
  assert.equal(model.replacementStart, 'read '.length);
  assert.equal(model.replacementEnd, 'read @d'.length);
  assert.deepEqual(model.items, [{ path: 'docs/', type: 'directory' }]);
});

test('buildFileMentionModel stays closed outside an active mention token', () => {
  const root = fixtureRoot();
  assert.equal(buildFileMentionModel({ text: 'read docs', cursorOffset: 9 }, root).open, false);
  assert.equal(buildFileMentionModel({ text: 'read @docs/T', cursorOffset: 'read '.length }, root).open, false);
  assert.equal(buildFileMentionModel({ text: 'email a@b', cursorOffset: 'email a@b'.length }, root).open, false);
});

test('listFileMentionItems searches nested prefixes within root', () => {
  const root = fixtureRoot();

  assert.deepEqual(
    listFileMentionItems(root, 'docs/T'),
    [
      { path: 'docs/TEXTAREA.md', type: 'file' },
      { path: 'docs/TUI.md', type: 'file' },
    ],
  );
  assert.equal(listFileMentionItems(root, '../').length, 0);
  assert.equal(listFileMentionItems(root, 'node_modules/').length, 0);
});

test('completeFileMentionInput replaces the active mention token', () => {
  const root = fixtureRoot();
  const input = { text: 'please inspect @docs/T', cursorOffset: 'please inspect @docs/T'.length };
  const model = buildFileMentionModel(input, root, 1);

  assert.deepEqual(completeFileMentionInput(input, model), {
    text: 'please inspect @docs/TUI.md ',
    cursorOffset: 'please inspect @docs/TUI.md '.length,
  });
  assert.equal(moveFileMentionSelection(model, -1), 0);
});
