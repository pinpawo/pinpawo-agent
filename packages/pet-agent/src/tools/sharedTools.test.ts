import test from 'node:test';
import assert from 'node:assert/strict';

import { createPetProfileToolkit, petProfileToolOperations } from './petProfile';
import { createMemoriesToolkit, memoriesToolOperations } from './memories';
import { createWebSearchToolkit, webSearchToolOperations } from './webSearch';

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
  assert.equal(toolkit.operations?.describe_pet_profile?.kind, 'pet.profile.read');
  assert.equal(toolkit.operations?.describe_pet_profile, petProfileToolOperations.describe_pet_profile);
});

test('shared memory tool exposes operation metadata without raw memory content', () => {
  const toolkit = createMemoriesToolkit();
  const metadata = memoriesToolOperations.get_memories;

  assert.equal(toolkit.name, 'memory');
  assert.ok(Array.isArray(toolkit.tools));
  assert.equal(toolkit.tools[0]?.name, 'get_memories');
  assert.equal(toolkit.operations?.get_memories, metadata);
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
  const toolkit = createWebSearchToolkit();
  const metadata = webSearchToolOperations.search_web;

  assert.equal(toolkit.name, 'web_search');
  assert.ok(Array.isArray(toolkit.tools));
  assert.equal(toolkit.tools[0]?.name, 'search_web');
  assert.equal(toolkit.operations?.search_web, metadata);
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
