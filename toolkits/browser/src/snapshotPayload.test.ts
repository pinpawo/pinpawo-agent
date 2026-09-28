import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBrowserExtractPayloadFromRaw,
  buildBrowserSnapshotPayload,
  parseBrowserRawExtract,
  parseBrowserRawSnapshot,
} from './snapshotPayload';

const tree = '- heading "Example" [level=1]\n  - button "Go" [ref=ax:6A1F0C3E:12:button]';
const rawTree = {
  title: 'Example',
  url: 'https://example.com/',
  tree,
  treeLength: tree.length,
  refCount: 1,
  source: 'accessibility',
};

test('raw browser snapshots are validated and normalized before payload building (#873)', () => {
  const raw = parseBrowserRawSnapshot(rawTree);
  const payload = buildBrowserSnapshotPayload(raw);

  assert.equal(payload.tree, rawTree.tree);
  assert.equal(payload.source, 'accessibility');
  assert.equal(payload.refCount, 1);
  assert.equal(payload.truncated, false);
  assert.equal('note' in payload, false);
});

test('raw extension extract windows are validated and normalized locally', () => {
  const raw = parseBrowserRawExtract({
    title: 'Example',
    url: 'https://example.com/',
    text: 'world',
    textLength: 11,
    offset: 6,
    limit: 5,
    textSource: 'document.body.innerText',
  });
  const payload = buildBrowserExtractPayloadFromRaw(raw);
  assert.equal(payload.text, 'world');
  assert.equal(payload.textEndOffset, 11);
  assert.equal(payload.hasMore, false);
  assert.equal(payload.truncated, true);
  assert.throws(() => parseBrowserRawExtract({
    ...raw,
    offset: 9,
  }), /fit within textLength/);
});

test('snapshot builder cuts a long tree at a line boundary and says how to see more (#873)', () => {
  const line = '- text: "' + 'x'.repeat(90) + '"';
  const tree = Array.from({ length: 1_000 }, () => line).join('\n');
  const payload = buildBrowserSnapshotPayload(parseBrowserRawSnapshot({
    ...rawTree,
    tree,
    treeLength: 3_000_000,
  }));

  assert.ok(payload.tree.length <= 50_000);
  assert.ok(payload.tree.endsWith('"'), 'the cut keeps whole lines');
  assert.equal(payload.returnedTreeLength, payload.tree.length);
  assert.equal(payload.treeLength, 3_000_000);
  assert.equal(payload.truncated, true);
  assert.match(String(payload.note), /browser_extract/);
});

test('snapshot builder reports a tree the extension already bounded as truncated', () => {
  const payload = buildBrowserSnapshotPayload(parseBrowserRawSnapshot({
    ...rawTree,
    treeLength: 1_500_000,
  }));
  assert.equal(payload.tree, rawTree.tree);
  assert.equal(payload.truncated, true);
});

test('raw snapshot parser rejects malformed backend data', () => {
  assert.throws(() => parseBrowserRawSnapshot({ ...rawTree, tree: 1 }), /must be strings/);
  assert.throws(() => parseBrowserRawSnapshot({ ...rawTree, treeLength: 3 }), /cover the returned tree/);
  assert.throws(() => parseBrowserRawSnapshot({ ...rawTree, refCount: -1 }), /refCount/);
  assert.throws(() => parseBrowserRawSnapshot({ ...rawTree, source: 'pixels' }), /accessibility or dom/);
  assert.throws(() => parseBrowserRawSnapshot({
    ...rawTree,
    tree: 'x'.repeat(2_000_001),
    treeLength: 2_000_001,
  }), /exceeds/);
});
