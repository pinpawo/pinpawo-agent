import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  completeFileMention,
  createFileMentionState,
  listFileMentionItems,
  moveFileMentionSelection,
  resolveFileMentionKey,
  syncFileMention,
} from './fileMention';

function createFixture() {
  const parent = mkdtempSync(path.join(tmpdir(), 'pinpawo-file-mention-'));
  const root = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  mkdirSync(path.join(root, 'docs'));
  mkdirSync(path.join(root, 'services'));
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'README.md'), 'hello\n');
  writeFileSync(path.join(root, 'dist'), 'not a directory\n');
  writeFileSync(path.join(root, 'docs', 'TEXTAREA.md'), 'textarea\n');
  writeFileSync(path.join(root, 'docs', 'TUI.md'), 'tui\n');
  writeFileSync(path.join(outside, 'secret.md'), 'secret\n');
  symlinkSync(outside, path.join(root, 'outside-link'));
  return {
    root,
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  };
}

test('file mention opens only for an active standalone @ token', (context) => {
  const { root, cleanup } = createFixture();
  context.after(cleanup);
  const input = {
    text: 'read @d',
    cursorOffset: 'read @d'.length,
  };
  const state = syncFileMention(
    createFileMentionState(),
    input,
    root,
    true,
  );
  assert.deepEqual(state, {
    phase: 'open',
    query: 'd',
    replacementStart: 'read '.length,
    replacementEnd: 'read @d'.length,
    selectedIndex: 0,
    items: [
      { path: 'docs/', type: 'directory' },
      { path: 'dist', type: 'file' },
    ],
  });
  assert.equal(syncFileMention(
    state,
    { text: 'email a@b', cursorOffset: 'email a@b'.length },
    root,
    true,
  ).phase, 'closed');
  assert.equal(syncFileMention(
    state,
    input,
    root,
    false,
  ).phase, 'closed');
});

test('file mention searches nested paths without escaping the workspace', (context) => {
  const { root, cleanup } = createFixture();
  context.after(cleanup);
  assert.deepEqual(listFileMentionItems(root, 'docs/T'), [
    { path: 'docs/TEXTAREA.md', type: 'file' },
    { path: 'docs/TUI.md', type: 'file' },
  ]);
  assert.deepEqual(listFileMentionItems(root, '../'), []);
  assert.deepEqual(listFileMentionItems(root, 'node_modules/'), []);
  assert.ok(
    !listFileMentionItems(root, '').some((item) => (
      item.path === 'outside-link/'
    )),
  );
  assert.ok(listFileMentionItems(root, '').some((item) => (
    item.path === 'dist' && item.type === 'file'
  )));
});

test('file mention completes directories and files at the composer cursor', (context) => {
  const { root, cleanup } = createFixture();
  context.after(cleanup);
  const directoryInput = {
    text: 'inspect @d later',
    cursorOffset: 'inspect @d'.length,
  };
  const directoryState = syncFileMention(
    createFileMentionState(),
    directoryInput,
    root,
    true,
  );
  assert.deepEqual(completeFileMention(
    directoryInput,
    directoryState,
  ), {
    text: 'inspect @docs/ later',
    cursorOffset: 'inspect @docs/'.length,
  });

  const fileInput = {
    text: 'inspect @docs/T',
    cursorOffset: 'inspect @docs/T'.length,
  };
  let fileState = syncFileMention(
    createFileMentionState(),
    fileInput,
    root,
    true,
  );
  fileState = moveFileMentionSelection(fileState, 1);
  assert.deepEqual(completeFileMention(fileInput, fileState), {
    text: 'inspect @docs/TUI.md ',
    cursorOffset: 'inspect @docs/TUI.md '.length,
  });

  const middleInput = {
    text: '中文 @docs/TUI.md suffix',
    cursorOffset: '中文 @d'.length,
  };
  const middleState = syncFileMention(
    createFileMentionState(),
    middleInput,
    root,
    true,
  );
  assert.deepEqual(completeFileMention(middleInput, middleState), {
    text: '中文 @docs/ suffix',
    cursorOffset: '中文 @docs/'.length,
  });
});

test('file mention owns navigation and completion keys only while open', (context) => {
  const { root, cleanup } = createFixture();
  context.after(cleanup);
  const open = syncFileMention(
    createFileMentionState(),
    { text: '@', cursorOffset: 1 },
    root,
    true,
  );
  assert.equal(resolveFileMentionKey(open, { name: 'up' }), 'previous');
  assert.equal(resolveFileMentionKey(open, { name: 'down' }), 'next');
  assert.equal(resolveFileMentionKey(open, { name: 'tab' }), 'complete');
  assert.equal(resolveFileMentionKey(open, { name: 'return' }), 'complete');
  assert.equal(resolveFileMentionKey(open, { name: 'escape' }), 'dismiss');
  assert.equal(resolveFileMentionKey(open, {
    name: 'up',
    shift: true,
  }), null);
  assert.equal(resolveFileMentionKey(open, {
    name: 'c',
    ctrl: true,
  }), null);
});
