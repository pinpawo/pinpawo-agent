import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createFileWikiAccess } from './wikiAccess';

test('readIndex returns the wiki index and degrades to null when absent', async () => {
  const access = createFileWikiAccess();
  const wikiRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-wiki-access-'));

  // 索引缺失是正常状态(知识库尚未生成),不该抛错。
  assert.equal(await access.readIndex(wikiRoot), null);

  await fs.writeFile(path.join(wikiRoot, 'index.md'), '# 知识库索引\n', 'utf8');
  assert.match((await access.readIndex(wikiRoot)) ?? '', /知识库索引/);

  await fs.rm(wikiRoot, { recursive: true, force: true });
});
