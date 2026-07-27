import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import { buildFileMentionViewModel } from './fileMentionViewModel';

test('file mention view marks the selected item and stays within its width', () => {
  const model = buildFileMentionViewModel({
    phase: 'open',
    query: 'docs/',
    replacementStart: 0,
    replacementEnd: 6,
    selectedIndex: 1,
    items: [
      { path: 'docs/reference/', type: 'directory' },
      { path: 'docs/非常长的终端交互设计说明.md', type: 'file' },
    ],
  }, 30);

  assert.equal(model.title, ' Files · @docs/ ');
  assert.match(model.content, /  docs\/reference\/  dir/);
  assert.match(model.content, /› docs\/.*  file/);
  assert.ok(
    model.content.split('\n').every((line) => stringWidth(line) <= 26),
    model.content,
  );
});

test('file mention view explains an empty match', () => {
  const model = buildFileMentionViewModel({
    phase: 'open',
    query: 'missing',
    replacementStart: 0,
    replacementEnd: 8,
    selectedIndex: 0,
    items: [],
  }, 40);
  assert.match(model.content, /No matching workspace files/);
});
