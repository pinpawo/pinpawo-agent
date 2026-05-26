import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadStudioLocalConfig, parseStudioLocalConfig, resolveStudio } from './studioConfig';
import type { PetLocalConfig } from './petConfig';

async function mkTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function pet(petId: string, overrides: Partial<PetLocalConfig> = {}): PetLocalConfig {
  return {
    petId,
    name: `Pet ${petId}`,
    capabilities: [],
    ...overrides,
  };
}

test('parseStudioLocalConfig accepts minimal valid config', () => {
  const cfg = parseStudioLocalConfig(
    { studioId: 's1', plannerPetId: 'p1', agents: ['p1'] },
    'test-source',
  );
  assert.equal(cfg.studioId, 's1');
  assert.equal(cfg.plannerPetId, 'p1');
  assert.deepEqual(cfg.agents, ['p1']);
});

test('parseStudioLocalConfig keeps optional fields when provided', () => {
  const cfg = parseStudioLocalConfig(
    {
      studioId: 's1',
      name: 'My Studio',
      description: 'desc',
      plannerPetId: 'p1',
      agents: ['p1', 'p2'],
      curator: { promptPath: './curator.md' },
      maxIterationCount: 16,
      maxRetryPerTask: 3,
    },
    'test-source',
  );
  assert.equal(cfg.name, 'My Studio');
  assert.equal(cfg.curator?.promptPath, './curator.md');
  assert.equal(cfg.maxIterationCount, 16);
  assert.equal(cfg.maxRetryPerTask, 3);
});

test('parseStudioLocalConfig rejects non-object input', () => {
  assert.throws(() => parseStudioLocalConfig(null, 'src'), /not a JSON object/);
});

test('parseStudioLocalConfig requires studioId / plannerPetId / agents', () => {
  assert.throws(
    () => parseStudioLocalConfig({ plannerPetId: 'p1', agents: ['p1'] }, 'src'),
    /missing required string "studioId"/,
  );
  assert.throws(
    () => parseStudioLocalConfig({ studioId: 's1', agents: ['p1'] }, 'src'),
    /missing required string "plannerPetId"/,
  );
  assert.throws(
    () => parseStudioLocalConfig({ studioId: 's1', plannerPetId: 'p1' }, 'src'),
    /"agents" must be a non-empty string\[\]/,
  );
  assert.throws(
    () => parseStudioLocalConfig({ studioId: 's1', plannerPetId: 'p1', agents: [] }, 'src'),
    /"agents" must be a non-empty string\[\]/,
  );
});

test('parseStudioLocalConfig rejects bad guardrail values', () => {
  assert.throws(
    () => parseStudioLocalConfig(
      { studioId: 's1', plannerPetId: 'p1', agents: ['p1'], maxIterationCount: 0 },
      'src',
    ),
    /maxIterationCount.*positive integer/,
  );
  assert.throws(
    () => parseStudioLocalConfig(
      { studioId: 's1', plannerPetId: 'p1', agents: ['p1'], maxRetryPerTask: -1 },
      'src',
    ),
    /maxRetryPerTask.*positive integer/,
  );
});

test('parseStudioLocalConfig rejects bad curator shape', () => {
  assert.throws(
    () => parseStudioLocalConfig(
      { studioId: 's1', plannerPetId: 'p1', agents: ['p1'], curator: 'not-an-object' },
      'src',
    ),
    /"curator" must be an object/,
  );
  assert.throws(
    () => parseStudioLocalConfig(
      { studioId: 's1', plannerPetId: 'p1', agents: ['p1'], curator: { promptPath: '' } },
      'src',
    ),
    /"curator\.promptPath" must be a non-empty string/,
  );
});

test('loadStudioLocalConfig returns null when file does not exist', async () => {
  const result = await loadStudioLocalConfig(path.join(os.tmpdir(), 'nonexistent-' + Date.now() + '.json'));
  assert.equal(result, null);
});

test('loadStudioLocalConfig reads and parses a valid file', async () => {
  const dir = await mkTempDir('studio-cfg-');
  const filePath = path.join(dir, 'studio.json');
  await fs.writeFile(filePath, JSON.stringify({
    studioId: 's1',
    plannerPetId: 'p1',
    agents: ['p1', 'p2'],
  }), 'utf8');

  const cfg = await loadStudioLocalConfig(filePath);
  assert.equal(cfg?.studioId, 's1');
  assert.deepEqual(cfg?.agents, ['p1', 'p2']);
});

test('loadStudioLocalConfig surfaces invalid JSON', async () => {
  const dir = await mkTempDir('studio-cfg-badjson-');
  const filePath = path.join(dir, 'studio.json');
  await fs.writeFile(filePath, '{broken', 'utf8');

  await assert.rejects(
    () => loadStudioLocalConfig(filePath),
    /not valid JSON/,
  );
});

test('resolveStudio joins pet configs in agents order', () => {
  const studio = parseStudioLocalConfig(
    { studioId: 's1', plannerPetId: 'p2', agents: ['p1', 'p2', 'p3'] },
    'src',
  );
  const pets = [pet('p3'), pet('p1'), pet('p2'), pet('orphan')];

  const resolved = resolveStudio(studio, pets);
  assert.deepEqual(resolved.agents.map((p) => p.petId), ['p1', 'p2', 'p3']);
  assert.equal(resolved.planner.petId, 'p2');
});

test('resolveStudio rejects duplicate agents', () => {
  const studio = parseStudioLocalConfig(
    { studioId: 's1', plannerPetId: 'p1', agents: ['p1', 'p1'] },
    'src',
  );
  assert.throws(
    () => resolveStudio(studio, [pet('p1')]),
    /agents array has duplicate petId "p1"/,
  );
});

test('resolveStudio rejects plannerPetId not in agents', () => {
  const studio = parseStudioLocalConfig(
    { studioId: 's1', plannerPetId: 'manager', agents: ['p1', 'p2'] },
    'src',
  );
  assert.throws(
    () => resolveStudio(studio, [pet('manager'), pet('p1'), pet('p2')]),
    /plannerPetId "manager" is not in agents/,
  );
});

test('resolveStudio rejects unknown agent reference', () => {
  const studio = parseStudioLocalConfig(
    { studioId: 's1', plannerPetId: 'p1', agents: ['p1', 'ghost'] },
    'src',
  );
  assert.throws(
    () => resolveStudio(studio, [pet('p1')]),
    /agent "ghost" has no matching pet config/,
  );
});
