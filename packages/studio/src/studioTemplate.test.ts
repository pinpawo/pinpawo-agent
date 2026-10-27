import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
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
    writeFile(path.join(root, 'studio.json'), JSON.stringify({ studioId: 'demo', plugins: [{ id: '@pinpawo-plugin/project-files' }] })),
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

test('Studio init preserves a project Wiki and creates a separate configured Studio Wiki', async () => {
  const templateRoot = await createTemplate();
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-workdir-'));
  const studioDataRoot = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-data-'));
  await mkdir(path.join(workdir, 'wiki'));
  await writeFile(path.join(workdir, 'wiki', 'PROJECT.md'), 'original project Wiki\n');
  const result = await initStudioWorkdir({ workdir, templateRoot, studioDataRoot });
  const config = JSON.parse(await readFile(path.join(workdir, '.pinpawo', 'studio.json'), 'utf8'));
  assert.equal(config.plugins[0].options.wikiDirectory, result.wikiDirectory);
  assert.equal(path.basename(result.wikiDirectory), 'wiki');
  assert.match(path.basename(path.dirname(result.wikiDirectory)), /^[0-9a-f-]{36}$/i);
  assert.ok(result.files.includes(path.join(result.wikiDirectory, 'PROJECT.md')));
  assert.equal(await readFile(path.join(result.wikiDirectory, 'PROJECT.md'), 'utf8'), '# Project\n');
  assert.equal(await readFile(path.join(workdir, 'wiki', 'PROJECT.md'), 'utf8'), 'original project Wiki\n');
  await assert.rejects(readFile(path.join(workdir, 'README.md')), /ENOENT/);
});

test('Studio init refuses existing configuration without touching it or the knowledge root', async () => {
  const templateRoot = await createTemplate();
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-conflict-'));
  const studioDataRoot = path.join(await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-parent-')), 'data');
  await mkdir(path.join(workdir, '.pinpawo'));
  await writeFile(path.join(workdir, '.pinpawo', 'studio.json'), 'keep existing config\n');
  await assert.rejects(initStudioWorkdir({ workdir, templateRoot, studioDataRoot }), /refuses to overwrite/);
  assert.equal(await readFile(path.join(workdir, '.pinpawo', 'studio.json'), 'utf8'), 'keep existing config\n');
  await assert.rejects(readFile(path.join(studioDataRoot, 'any')), /ENOENT/);
});

test('Studio init refuses an existing data identity without modifying its files', async () => {
  const templateRoot = await createTemplate();
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-conflict-'));
  const studioDataRoot = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-data-'));
  const id = '00000000-0000-4000-8000-000000000000';
  await mkdir(path.join(studioDataRoot, id, 'wiki'), { recursive: true });
  await writeFile(path.join(studioDataRoot, id, 'wiki', 'PROJECT.md'), 'keep existing knowledge\n');
  await assert.rejects(initStudioWorkdir({ workdir, templateRoot, studioDataRoot, createStudioDataId: () => id }), /EEXIST/);
  assert.equal(await readFile(path.join(studioDataRoot, id, 'wiki', 'PROJECT.md'), 'utf8'), 'keep existing knowledge\n');
  await assert.rejects(readFile(path.join(workdir, '.pinpawo', 'studio.json')), /ENOENT/);
});

test('Studio init rolls back its seeded Wiki when project configuration creation fails', {
  skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0),
}, async (t) => {
  const templateRoot = await createTemplate();
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-workdir-'));
  const studioDataRoot = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-data-'));
  await chmod(workdir, 0o500);
  t.after(async () => { await chmod(workdir, 0o700); });
  await assert.rejects(initStudioWorkdir({ workdir, templateRoot, studioDataRoot }), /EACCES|EPERM/);
  assert.deepEqual(await readdir(studioDataRoot), [], 'failed initialization removes only its empty Studio data directory');
});

test('Studio init rejects knowledge roots inside the business workdir', async () => {
  const templateRoot = await createTemplate();
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-workdir-'));
  await assert.rejects(initStudioWorkdir({ workdir, templateRoot, studioDataRoot: path.join(workdir, 'state') }), /outside the project workdir/);
  await assert.rejects(readFile(path.join(workdir, '.pinpawo', 'studio.json')), /ENOENT/);
});

test('separate Studio initializations cannot silently share the same Wiki', async () => {
  const templateRoot = await createTemplate();
  const studioDataRoot = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-data-'));
  const firstWorkdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-first-'));
  const secondWorkdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-second-'));
  const first = await initStudioWorkdir({ workdir: firstWorkdir, templateRoot, studioDataRoot });
  const second = await initStudioWorkdir({ workdir: secondWorkdir, templateRoot, studioDataRoot });
  assert.notEqual(first.wikiDirectory, second.wikiDirectory);
  await writeFile(path.join(first.wikiDirectory, 'PROJECT.md'), 'first Studio only\n');
  assert.equal(await readFile(path.join(second.wikiDirectory, 'PROJECT.md'), 'utf8'), '# Project\n');
});

test('Studio init rejects a knowledge root reached through a symlink into the project', { skip: process.platform === 'win32' }, async () => {
  const templateRoot = await createTemplate();
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-workdir-'));
  const parent = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-parent-'));
  await symlink(workdir, path.join(parent, 'link'));
  await assert.rejects(
    initStudioWorkdir({ workdir, templateRoot, studioDataRoot: path.join(parent, 'link', 'hidden') }),
    /outside the project workdir/,
  );
  await assert.rejects(readFile(path.join(workdir, '.pinpawo', 'studio.json')), /ENOENT/);
});

test('Studio init does not add Project Files to a custom template', async () => {
  const templateRoot = await createTemplate();
  await writeFile(path.join(templateRoot, 'studio.json'), JSON.stringify({ studioId: 'custom', plugins: [] }));
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-custom-'));
  const studioDataRoot = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-data-'));
  const result = await initStudioWorkdir({ workdir, templateRoot, studioDataRoot });
  const config = JSON.parse(await readFile(path.join(workdir, '.pinpawo', 'studio.json'), 'utf8'));
  assert.deepEqual(config.plugins, []);
  assert.equal(await readFile(path.join(result.wikiDirectory, 'PROJECT.md'), 'utf8'), '# Project\n');
});

test('shipped Pet Capabilities support explicit execution, review, and Wiki requests', async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-shipped-template-'));
  await initStudioWorkdir({ workdir, studioDataRoot: await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-data-')) });

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
    ['files', 'shell', 'web', 'git', 'github', 'channel', 'project_files'],
  ]);
});
