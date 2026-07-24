import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import test from 'node:test';
import { rgPath } from '@vscode/ripgrep';
import { walkFiles, DEFAULT_WALK_IGNORED_DIRS } from './fileSystemUtils';
import {
  createArtifactDiscoveryFileTools,
  listDirTool,
  viewFileChunkTool,
} from './fileTools';
import { globSearchTool, grepSearchTool } from './searchTools';
import { ripgrepSearchBackend } from './searchBackend';

function makeTree() {
  const root = mkdtempSync(resolve(tmpdir(), 'pinpawo-search-'));
  return root;
}

test('search backend resolves the packaged ripgrep executable', () => {
  assert.ok(isAbsolute(rgPath));
});

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
  mkdirSync(resolve(root, '.git/objects'), { recursive: true });
  mkdirSync(resolve(root, 'node_modules/pkg'), { recursive: true });
  writeFileSync(resolve(root, '.git/objects/leak'), 'capability_search\n');
  writeFileSync(resolve(root, 'node_modules/pkg/index.js'), 'capability_search\n');

  const output = String(await grepSearchTool.invoke({ path: root, query: 'capability_search' }));

  assert.ok(output.includes('src/app.ts'), 'should still match real source files');
  assert.ok(!output.includes('.pinpawo'), 'must not return checkpoint storage matches');
  assert.ok(!output.includes('checkpoints-tui'), 'must not leak checkpoint paths');
  assert.ok(!output.includes('.git'), 'must not return git storage matches');
  assert.ok(!output.includes('node_modules'), 'must not return dependency matches');
});

test('grep_search truncates a single huge matched line', async () => {
  const root = makeTree();
  writeFileSync(resolve(root, 'big.json'), `${'a'.repeat(300_000)} needle\n`);

  const output = String(await grepSearchTool.invoke({ path: root, query: 'needle' }));

  assert.ok(output.includes('big.json'), 'matched the file');
  assert.ok(output.includes('truncated'), 'annotated the truncation');
  assert.ok(output.length < 100_000, `single match should be bounded, got ${output.length}`);
});

test('grep_search supports a single file search root with and without context', async () => {
  const root = makeTree();
  const filePath = resolve(root, 'single.ts');
  writeFileSync(filePath, [
    'before',
    'needle',
    'after',
  ].join('\n'));

  const plain = String(await grepSearchTool.invoke({
    path: filePath,
    query: 'needle',
  }));
  assert.match(plain, /^single\.ts:2: needle$/m);

  const withContext = String(await grepSearchTool.invoke({
    path: filePath,
    query: 'needle',
    context: 1,
  }));
  assert.match(withContext, /^single\.ts-1- before$/m);
  assert.match(withContext, /^single\.ts:2: needle$/m);
  assert.match(withContext, /^single\.ts-3- after$/m);
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

  assert.ok(output.includes('50000-byte output limit'), 'should report byte-budget truncation');
  assert.ok(Buffer.byteLength(output, 'utf-8') <= 50_000);
  // 50k cap + one final over-budget entry; comfortably under the unbounded ~300k.
  assert.ok(output.length < 120_000, `total output should be bounded, got ${output.length}`);
});

test('glob_search ignores .pinpawo and finds real files', async () => {
  const root = makeTree();
  mkdirSync(resolve(root, 'src'));
  writeFileSync(resolve(root, 'src/app.ts'), '');
  mkdirSync(resolve(root, '.pinpawo'));
  writeFileSync(resolve(root, '.pinpawo/state.ts'), '');
  mkdirSync(resolve(root, '.git'));
  mkdirSync(resolve(root, 'node_modules'));
  writeFileSync(resolve(root, '.git/state.ts'), '');
  writeFileSync(resolve(root, 'node_modules/state.ts'), '');

  const output = String(await globSearchTool.invoke({ path: root, pattern: '*.ts' }));

  assert.ok(output.includes('src/app.ts'));
  assert.ok(!output.includes('.pinpawo'), 'glob must not surface checkpoint storage');
  assert.ok(!output.includes('.git'), 'glob must not surface git storage');
  assert.ok(!output.includes('node_modules'), 'glob must not surface dependencies');
});

test('native searches honor .gitignore outside a git repository', async () => {
  const root = makeTree();
  mkdirSync(resolve(root, 'src'));
  mkdirSync(resolve(root, 'generated'));
  writeFileSync(resolve(root, '.gitignore'), 'generated/\nignored.ts\n');
  writeFileSync(resolve(root, 'src/kept.ts'), 'needle\n');
  writeFileSync(resolve(root, 'generated/noisy.ts'), 'needle\n');
  writeFileSync(resolve(root, 'ignored.ts'), 'needle\n');

  const grep = String(await grepSearchTool.invoke({ path: root, query: 'needle' }));
  const glob = String(await globSearchTool.invoke({ path: root, pattern: '*.ts' }));

  assert.match(grep, /^src\/kept\.ts:1: needle/m);
  assert.doesNotMatch(grep, /generated|ignored\.ts/);
  assert.match(glob, /^src\/kept\.ts$/m);
  assert.doesNotMatch(glob, /generated|ignored\.ts/);
  assert.doesNotMatch(`${grep}\n${glob}`, new RegExp(root));
});

test('grep_search supports literal, regex, glob, case, and merged context', async () => {
  const root = makeTree();
  mkdirSync(resolve(root, 'src'));
  writeFileSync(resolve(root, 'src/code.ts'), [
    'before',
    'Target123',
    'between',
    'target456',
    'after',
  ].join('\n'));
  writeFileSync(resolve(root, 'src/code.md'), 'target789\n');

  const literal = String(await grepSearchTool.invoke({
    path: root,
    query: 'target\\d+',
    literal: true,
  }));
  assert.equal(literal, '(no matches)');

  const regex = String(await grepSearchTool.invoke({
    path: root,
    query: 'target\\d+',
    literal: false,
    glob: '*.ts',
    context: 1,
  }));
  assert.match(regex, /^src\/code\.ts:2: Target123/m);
  assert.match(regex, /^src\/code\.ts:4: target456/m);
  assert.doesNotMatch(regex, /code\.md/);
  assert.equal((regex.match(/^src\/code\.ts-3-/gm) ?? []).length, 1);

  const sensitive = String(await grepSearchTool.invoke({
    path: root,
    query: 'target\\d+',
    literal: false,
    caseSensitive: true,
    glob: '*.ts',
  }));
  assert.doesNotMatch(sensitive, /Target123/);
  assert.match(sensitive, /target456/);
});

test('grep_search preserves context after disjoint ripgrep blocks', async () => {
  const root = makeTree();
  writeFileSync(resolve(root, 'code.ts'), [
    'before first',
    'needle first',
    'after first',
    'gap 1',
    'gap 2',
    'gap 3',
    'gap 4',
    'before second',
    'needle second',
    'after second',
  ].join('\n'));

  const output = String(await grepSearchTool.invoke({
    path: root,
    query: 'needle',
    context: 1,
  }));

  assert.match(output, /^code\.ts-8- before second$/m);
  assert.match(output, /^code\.ts:9: needle second$/m);
});

test('native searches reject symlink aliases into hard-excluded roots', async () => {
  const root = makeTree();
  const checkpointRoot = resolve(root, '.pinpawo');
  const alias = resolve(root, 'safe-alias');
  mkdirSync(checkpointRoot);
  writeFileSync(resolve(checkpointRoot, 'secret.ts'), 'needle\n');
  symlinkSync(
    checkpointRoot,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const grep = String(await grepSearchTool.invoke({ path: alias, query: 'needle' }));
  const glob = String(await globSearchTool.invoke({ path: alias, pattern: '*.ts' }));
  assert.match(grep, /^Error: search root is inside a hard-excluded directory/);
  assert.match(glob, /^Error: search root is inside a hard-excluded directory/);
});

test('native searches include non-ignored hidden files with consistent semantics', async () => {
  const root = makeTree();
  writeFileSync(resolve(root, '.hidden.ts'), 'hidden needle\n');

  const grep = String(await grepSearchTool.invoke({ path: root, query: 'hidden needle' }));
  const glob = String(await globSearchTool.invoke({ path: root, pattern: '*.ts' }));

  assert.match(grep, /^\.hidden\.ts:1:/m);
  assert.match(glob, /^\.hidden\.ts$/m);
});

test('search limit notices are explicit and actionable', async () => {
  const root = makeTree();
  writeFileSync(resolve(root, 'many.txt'), 'needle one\nneedle two\n');
  writeFileSync(resolve(root, 'other.txt'), 'other\n');

  const grep = String(await grepSearchTool.invoke({
    path: root,
    query: 'needle',
    limit: 1,
  }));
  assert.match(grep, /match limit 1/);
  assert.match(grep, /narrow path\/query\/glob or increase limit/);

  const glob = String(await globSearchTool.invoke({
    path: root,
    pattern: '*',
    limit: 1,
  }));
  assert.match(glob, /result limit 1/);
  assert.match(glob, /narrow pattern\/path or increase limit/);
});

test('grep_search reports invalid regex deterministically', async () => {
  const root = makeTree();
  writeFileSync(resolve(root, 'code.ts'), 'text\n');

  const output = String(await grepSearchTool.invoke({
    path: root,
    query: '[',
    literal: false,
  }));
  assert.match(output, /^Error: rg: regex parse error:/);
});

test('ripgrep backend accepts AbortSignal', async () => {
  const root = makeTree();
  writeFileSync(resolve(root, 'code.ts'), 'needle\n');
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    ripgrepSearchBackend.grep({
      rootPath: root,
      query: 'needle',
      literal: true,
      caseSensitive: false,
      context: 0,
      maxMatches: 2,
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
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
  const scopedListDir = scopedTools.find((toolItem) => toolItem.name === 'artifact_list_dir');
  const scopedViewFileChunk = scopedTools.find(
    (toolItem) => toolItem.name === 'artifact_view_file_chunk',
  );
  assert.ok(scopedListDir);
  assert.ok(scopedViewFileChunk);
  assert.match(String(await scopedListDir.invoke({ path: artifactDir })), /manifest\.json/);
  assert.match(String(await scopedViewFileChunk.invoke({
    path: resolve(artifactDir, 'manifest.json'),
  })), /artifact shortcut/);
});

test('artifact discovery tools report a clean result when the thread root is missing', async () => {
  const missingThreadRoot = resolve(makeTree(), 'threads/missing-thread');
  const scopedTools = createArtifactDiscoveryFileTools(missingThreadRoot);
  const scopedListDir = scopedTools.find((toolItem) => toolItem.name === 'artifact_list_dir');
  const scopedViewFileChunk = scopedTools.find(
    (toolItem) => toolItem.name === 'artifact_view_file_chunk',
  );
  assert.ok(scopedListDir);
  assert.ok(scopedViewFileChunk);

  const listing = String(await scopedListDir.invoke({ path: '.' }));
  const content = String(await scopedViewFileChunk.invoke({ path: 'manifest.json' }));
  assert.match(listing, /current thread has no artifacts/);
  assert.match(content, /current thread has no artifacts/);
  assert.doesNotMatch(`${listing}\n${content}`, /ENOENT/);
});
