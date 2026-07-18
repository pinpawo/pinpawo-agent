import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { walkFiles, DEFAULT_WALK_IGNORED_DIRS } from './fileSystemUtils';
import {
  createArtifactDiscoveryFileTools,
  listDirTool,
  viewFileChunkTool,
} from './fileTools';
import { globSearchTool, grepSearchTool } from './searchTools';

function makeTree() {
  const root = mkdtempSync(resolve(tmpdir(), 'pinpawo-search-'));
  return root;
}

test('walkFiles skips .pinpawo / .git / node_modules by default', () => {
  const root = makeTree();
  mkdirSync(resolve(root, 'src'));
  writeFileSync(resolve(root, 'src/app.ts'), 'needle here\n');
  for (const ignored of DEFAULT_WALK_IGNORED_DIRS) {
    mkdirSync(resolve(root, ignored));
    writeFileSync(resolve(root, ignored, 'leak.txt'), 'needle here\n');
  }

  const visited: string[] = [];
  walkFiles(root, (filePath) => {
    visited.push(filePath);
  });

  assert.ok(visited.some((p) => p.endsWith('src/app.ts')));
  for (const ignored of DEFAULT_WALK_IGNORED_DIRS) {
    assert.ok(
      !visited.some((p) => p.includes(`/${ignored}/`)),
      `expected walk to skip ${ignored}`,
    );
  }
});

test('grep_search does not descend into .pinpawo checkpoint storage', async () => {
  const root = makeTree();
  mkdirSync(resolve(root, 'src'));
  writeFileSync(resolve(root, 'src/app.ts'), 'capability_search marker\n');
  mkdirSync(resolve(root, '.pinpawo/checkpoints-tui/objects/00'), { recursive: true });
  // One ~493KB single-line serialized-history object, like the real blow-up.
  writeFileSync(
    resolve(root, '.pinpawo/checkpoints-tui/objects/00/deadbeef'),
    `${'x'.repeat(490_000)} capability_search ${'y'.repeat(3_000)}\n`,
  );

  const output = String(await grepSearchTool.invoke({ path: root, query: 'capability_search' }));

  assert.ok(output.includes('src/app.ts'), 'should still match real source files');
  assert.ok(!output.includes('.pinpawo'), 'must not return checkpoint storage matches');
  assert.ok(!output.includes('checkpoints-tui'), 'must not leak checkpoint paths');
});

test('grep_search truncates a single huge matched line', async () => {
  const root = makeTree();
  writeFileSync(resolve(root, 'big.json'), `${'a'.repeat(300_000)} needle\n`);

  const output = String(await grepSearchTool.invoke({ path: root, query: 'needle' }));

  assert.ok(output.includes('big.json'), 'matched the file');
  assert.ok(output.includes('truncated'), 'annotated the truncation');
  assert.ok(output.length < 100_000, `single match should be bounded, got ${output.length}`);
});

test('grep_search stops at the total-bytes budget across many big lines', async () => {
  const root = makeTree();
  for (let i = 0; i < 200; i += 1) {
    writeFileSync(
      resolve(root, `f${i}.txt`),
      `${'z'.repeat(1_500)} needle\n`,
    );
  }

  const output = String(await grepSearchTool.invoke({ path: root, query: 'needle', limit: 200 }));

  assert.ok(output.includes('上限并截断'), 'should report byte-budget truncation');
  // 50k cap + one final over-budget entry; comfortably under the unbounded ~300k.
  assert.ok(output.length < 120_000, `total output should be bounded, got ${output.length}`);
});

test('glob_search ignores .pinpawo and finds real files', async () => {
  const root = makeTree();
  mkdirSync(resolve(root, 'src'));
  writeFileSync(resolve(root, 'src/app.ts'), '');
  mkdirSync(resolve(root, '.pinpawo'));
  writeFileSync(resolve(root, '.pinpawo/state.ts'), '');

  const output = String(await globSearchTool.invoke({ path: root, pattern: '*.ts' }));

  assert.ok(output.includes('src/app.ts'));
  assert.ok(!output.includes('.pinpawo'), 'glob must not surface checkpoint storage');
});

test('explicit file tools can inspect a scoped artifact path under .pinpawo', async () => {
  const root = makeTree();
  const threadRoot = resolve(
    root,
    '.pinpawo/capability-artifacts/threads/thread-1',
  );
  const artifactDir = resolve(threadRoot, 'delegation-1');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(resolve(artifactDir, 'manifest.json'), '{"title":"artifact shortcut"}\n');

  const listing = String(await listDirTool.invoke({ path: artifactDir }));
  const content = String(await viewFileChunkTool.invoke({
    path: resolve(artifactDir, 'manifest.json'),
  }));

  assert.match(listing, /manifest\.json/);
  assert.match(content, /artifact shortcut/);

  const scopedTools = createArtifactDiscoveryFileTools(threadRoot);
  const scopedListDir = scopedTools.find((toolItem) => toolItem.name === 'list_dir');
  const scopedViewFileChunk = scopedTools.find(
    (toolItem) => toolItem.name === 'view_file_chunk',
  );
  assert.ok(scopedListDir);
  assert.ok(scopedViewFileChunk);
  assert.match(String(await scopedListDir.invoke({ path: artifactDir })), /manifest\.json/);
  assert.match(String(await scopedViewFileChunk.invoke({
    path: resolve(artifactDir, 'manifest.json'),
  })), /artifact shortcut/);
});
