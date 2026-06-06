import test from 'node:test';
import assert from 'node:assert/strict';

import { createPetProfileToolkit } from './petProfile';
import { createMemoriesToolkit } from './memories';
import { createWebSearchToolkit } from './webSearch';

test('shared pet profile toolkit exposes tool operation metadata', () => {
  const toolkit = createPetProfileToolkit({
    actor: {
      petId: 'pet-1',
      userId: null,
      name: '小羊',
      personality: '认真',
      stage: 'sprout',
      species: 'sheep',
    },
  });

  assert.equal(toolkit.name, 'pet_profile');
  assert.ok(Array.isArray(toolkit.tools));
  assert.equal(toolkit.tools[0]?.name, 'describe_pet_profile');
  assert.equal(toolkit.operations?.describe_pet_profile?.title, '读取宠物资料');
});

test('shared memory tool exposes operation metadata without raw memory content', () => {
  const toolkit = createMemoriesToolkit();
  const metadata = toolkit.operations?.get_memories;

  assert.equal(toolkit.name, 'memory');
  assert.ok(Array.isArray(toolkit.tools));
  assert.equal(toolkit.tools[0]?.name, 'get_memories');
  assert.ok(metadata);
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
  const toolkit = createWebSearchToolkit();
  const metadata = toolkit.operations?.search_web;

  assert.equal(toolkit.name, 'web_search');
  assert.ok(Array.isArray(toolkit.tools));
  assert.equal(toolkit.tools[0]?.name, 'search_web');
  assert.ok(metadata);
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
