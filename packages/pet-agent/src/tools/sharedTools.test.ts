import test from 'node:test';
import assert from 'node:assert/strict';

import { memoriesToolOperations } from './memories';
import { webSearchToolOperations } from './webSearch';

test('shared memory tool exposes operation metadata without raw memory content', () => {
  const metadata = memoriesToolOperations.get_memories;

  assert.equal(metadata.kind, 'memory.search');
  assert.equal(metadata.title, '搜索记忆');
  assert.deepEqual(metadata.summarizeInput?.({
    query: '最近喜欢什么',
    limit: 3,
  }), {
    target: '最近喜欢什么',
    summary: '最近喜欢什么',
    details: { limit: 3 },
  });
  assert.deepEqual(metadata.summarizeOutput?.(JSON.stringify({
    ok: true,
    count: 2,
    memories: [{ content: 'private memory' }],
  })), {
    summary: '找到 2 条记忆',
  });
});

test('shared web search tool exposes operation metadata without raw result snippets', () => {
  const metadata = webSearchToolOperations.search_web;

  assert.equal(metadata.kind, 'web.search');
  assert.equal(metadata.title, '搜索网页');
  assert.deepEqual(metadata.summarizeInput?.({
    query: 'PinPawo',
    limit: 4,
  }), {
    target: 'PinPawo',
    summary: 'PinPawo',
    details: { limit: 4 },
  });
  assert.deepEqual(metadata.summarizeOutput?.(JSON.stringify({
    ok: true,
    count: 1,
    results: [{ title: 'PinPawo', snippet: 'raw snippet' }],
  })), {
    summary: '找到 1 条结果',
  });
});
