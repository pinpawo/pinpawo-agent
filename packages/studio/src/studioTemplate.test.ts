import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCapabilityDirectory } from 'pinpawo/host-runtime';
import test from 'node:test';
import { initStudioKickstart } from './studioTemplate';

async function createTemplate(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-template-'));
  await Promise.all([
    mkdir(path.join(root, '.pinpawo', 'pets', 'planner', 'capabilities', 'planning'), { recursive: true }),
    mkdir(path.join(root, 'wiki'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, '.pinpawo', 'studio.json'), '{"studioId":"demo"}\n'),
    writeFile(path.join(root, '.pinpawo', 'pets', 'planner.json'), '{"petId":"planner"}\n'),
    writeFile(
      path.join(root, '.pinpawo', 'pets', 'planner', 'capabilities', 'planning', 'CAPABILITY.md'),
      '# Planning\n',
    ),
    writeFile(path.join(root, 'wiki', 'PROJECT.md'), '# Project\n'),
    writeFile(path.join(root, 'README.md'), 'must not be copied\n'),
  ]);
  return root;
}

test('kickstart init copies only runtime config, Pet Capabilities, and Wiki Markdown', async () => {
  const templateRoot = await createTemplate();
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-workdir-'));
  const result = await initStudioKickstart({ workdir, templateRoot });

  assert.deepEqual(result.files.sort(), [
    '.pinpawo/pets/planner.json',
    '.pinpawo/pets/planner/capabilities/planning/CAPABILITY.md',
    '.pinpawo/studio.json',
    'wiki/PROJECT.md',
  ].sort());
  assert.equal(await readFile(path.join(workdir, 'wiki', 'PROJECT.md'), 'utf8'), '# Project\n');
  await assert.rejects(readFile(path.join(workdir, 'README.md')), /ENOENT/);
});

test('kickstart init preflights conflicts before copying any file', async () => {
  const templateRoot = await createTemplate();
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-conflict-'));
  await mkdir(path.join(workdir, 'wiki'), { recursive: true });
  await writeFile(path.join(workdir, 'wiki', 'PROJECT.md'), 'keep me\n');

  await assert.rejects(
    initStudioKickstart({ workdir, templateRoot }),
    /refuses to overwrite/,
  );
  await assert.rejects(
    readFile(path.join(workdir, '.pinpawo', 'studio.json')),
    /ENOENT/,
  );
  assert.equal(await readFile(path.join(workdir, 'wiki', 'PROJECT.md'), 'utf8'), 'keep me\n');
});

test('shipped Pet Capabilities separate planning, execution, and Wiki observation', async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-shipped-template-'));
  await initStudioKickstart({ workdir });

  const capabilities = await loadCapabilityDirectory(path.join(
    workdir,
    '.pinpawo',
    'pets',
    'planner',
    'capabilities',
  ));
  assert.deepEqual(
    capabilities.map(({ capability }) => ({
      name: capability.name,
      uses: capability.uses,
    })),
    [
      { name: 'studio_exploration', uses: ['project-inspection'] },
      { name: 'studio_planning', uses: ['kanban-planning'] },
    ],
  );

  const studioConfig = JSON.parse(await readFile(
    path.join(workdir, '.pinpawo', 'studio.json'),
    'utf8',
  )) as { plugins: Array<{ id: string; options?: Record<string, unknown> }> };
  const kanban = studioConfig.plugins.find(({ id }) => id === '@pinpawo-plugin/kanban');
  assert.deepEqual(kanban?.options?.assignablePetIds, ['executor', 'reviewer']);

  const executorCapabilities = await loadCapabilityDirectory(path.join(
    workdir,
    '.pinpawo',
    'pets',
    'executor',
    'capabilities',
  ));
  const reviewerCapabilities = await loadCapabilityDirectory(path.join(
    workdir,
    '.pinpawo',
    'pets',
    'reviewer',
    'capabilities',
  ));
  const wikiCapabilities = await loadCapabilityDirectory(path.join(
    workdir,
    '.pinpawo',
    'pets',
    'wiki',
    'capabilities',
  ));
  assert.deepEqual(executorCapabilities.map(({ capability }) => capability.uses), [
    ['bash', 'git', 'kanban-execution'],
  ]);
  assert.deepEqual(reviewerCapabilities.map(({ capability }) => capability.uses), [
    ['bash', 'git', 'kanban-execution'],
  ]);
  assert.deepEqual(wikiCapabilities.map(({ capability }) => capability.uses), [
    ['bash', 'git', 'kanban-observation'],
  ]);
});
