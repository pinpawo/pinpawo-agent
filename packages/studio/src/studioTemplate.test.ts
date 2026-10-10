import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCapabilityDirectory } from 'pinpawo/host-runtime';
import test from 'node:test';
import { initStudioWorkdir } from './studioTemplate';

async function createTemplate(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-template-'));
  await Promise.all([
    mkdir(path.join(root, 'pets', 'executor', 'capabilities', 'execution'), { recursive: true }),
    mkdir(path.join(root, 'wiki'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, 'studio.json'), '{"studioId":"demo"}\n'),
    writeFile(path.join(root, 'pets', 'executor.json'), '{"petId":"executor"}\n'),
    writeFile(path.join(root, 'pets', 'executor', 'PET.md'), '# Executor\n'),
    writeFile(
      path.join(root, 'pets', 'executor', 'capabilities', 'execution', 'CAPABILITY.md'),
      '# Execution\n',
    ),
    writeFile(path.join(root, 'wiki', 'PROJECT.md'), '# Project\n'),
    writeFile(path.join(root, 'README.md'), 'must not be copied\n'),
  ]);
  return root;
}

test('Studio init copies configuration, Pet documents and Capabilities, and Wiki Markdown', async () => {
  const templateRoot = await createTemplate();
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-workdir-'));
  const result = await initStudioWorkdir({ workdir, templateRoot });

  assert.deepEqual(result.files.sort(), [
    '.pinpawo/pets/executor.json',
    '.pinpawo/pets/executor/PET.md',
    '.pinpawo/pets/executor/capabilities/execution/CAPABILITY.md',
    '.pinpawo/studio.json',
    'wiki/PROJECT.md',
  ].sort());
  assert.equal(await readFile(path.join(workdir, 'wiki', 'PROJECT.md'), 'utf8'), '# Project\n');
  await assert.rejects(readFile(path.join(workdir, 'README.md')), /ENOENT/);
});

test('Studio init preflights conflicts before copying any file', async () => {
  const templateRoot = await createTemplate();
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-conflict-'));
  await mkdir(path.join(workdir, 'wiki'), { recursive: true });
  await writeFile(path.join(workdir, 'wiki', 'PROJECT.md'), 'keep me\n');

  await assert.rejects(
    initStudioWorkdir({ workdir, templateRoot }),
    /refuses to overwrite/,
  );
  await assert.rejects(
    readFile(path.join(workdir, '.pinpawo', 'studio.json')),
    /ENOENT/,
  );
  assert.equal(await readFile(path.join(workdir, 'wiki', 'PROJECT.md'), 'utf8'), 'keep me\n');
});

test('shipped Pet Capabilities support explicit execution, review, and Wiki requests', async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-shipped-template-'));
  await initStudioWorkdir({ workdir });

  const studioConfig = JSON.parse(await readFile(
    path.join(workdir, '.pinpawo', 'studio.json'),
    'utf8',
  )) as { entryPetId: string; pets: string[]; plugins: Array<{ id: string; options?: Record<string, unknown> }> };
  assert.equal(studioConfig.entryPetId, 'executor');
  assert.deepEqual(studioConfig.pets, ['executor', 'reviewer', 'wiki']);
  assert.deepEqual(studioConfig.plugins.map(({ id }) => id), [
    '@pinpawo-plugin/studio-http', '@pinpawo-plugin/notice', '@pinpawo-plugin/channel',
    '@pinpawo-plugin/scheduler', '@pinpawo-plugin/project-files', '@pinpawo-plugin/trigger',
  ]);
  const scheduler = studioConfig.plugins.find(({ id }) => id === '@pinpawo-plugin/scheduler');
  assert.deepEqual(scheduler?.options, {
    dispatchQueueAudit: {
      intervalMs: 600000,
      attentionStates: ['waiting', 'blocked'],
    },
  });
  const notice = studioConfig.plugins.find(({ id }) => id === '@pinpawo-plugin/notice');
  assert.deepEqual(notice?.options, {
    rules: [{
      noticeId: 'dispatch-queues-attention',
      title: 'Dispatch queues need attention',
      level: 'warning',
      source: {
        kind: 'studio_event',
        eventSource: 'scheduler',
        type: 'dispatch.queues_attention_required',
      },
    }],
  });

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
  assert.deepEqual(executorCapabilities.map(({ capability }) => ({ name: capability.name, uses: capability.uses })), [
    { name: 'studio_execution', uses: ['files', 'shell', 'web', 'git', 'github', 'channel'] },
  ]);
  assert.deepEqual(reviewerCapabilities.map(({ capability }) => ({ name: capability.name, uses: capability.uses })), [
    { name: 'studio_review', uses: ['files', 'shell', 'web', 'git', 'github', 'channel'] },
  ]);
  assert.deepEqual(wikiCapabilities.map(({ capability }) => capability.uses), [
    ['files', 'shell', 'web', 'git', 'github', 'channel'],
  ]);
});
