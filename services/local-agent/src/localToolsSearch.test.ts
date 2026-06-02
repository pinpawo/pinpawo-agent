import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  globSearchTool,
  grepSearchTool,
} from './plugins/localTools/searchTools';

function createSearchFixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'pinpawo-search-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(resolve(root, 'src', 'deep'), { recursive: true });
  writeFileSync(resolve(root, 'src', 'main.ts'), 'Target line\nsecond line\n', 'utf-8');
  writeFileSync(resolve(root, 'src', 'deep', 'helper.ts'), 'target lower\n', 'utf-8');
  writeFileSync(resolve(root, 'notes.md'), 'no match here\n', 'utf-8');

  return root;
}

test('globSearchTool searches recursively and respects limit', async (t) => {
  const root = createSearchFixture(t);
  const output = String(await globSearchTool.invoke({
    path: root,
    pattern: '*.ts',
    limit: 1,
  }));

  const matches = output.split('\n').filter(Boolean);
  assert.equal(matches.length, 1);
  assert.match(matches[0] ?? '', /\.ts$/);
});

test('grepSearchTool searches file content with case sensitivity controls', async (t) => {
  const root = createSearchFixture(t);

  const insensitive = String(await grepSearchTool.invoke({
    path: root,
    query: 'target',
    limit: 10,
  }));
  assert.match(insensitive, /main\.ts:1: Target line/);
  assert.match(insensitive, /helper\.ts:1: target lower/);

  const sensitive = String(await grepSearchTool.invoke({
    path: root,
    query: 'target',
    limit: 10,
    caseSensitive: true,
  }));
  assert.doesNotMatch(sensitive, /Target line/);
  assert.match(sensitive, /helper\.ts:1: target lower/);
});
