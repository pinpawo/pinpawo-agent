import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatStudioMigratePlan, migrateStudioConfig } from './commands/studio';
import type { LocalAgentRuntimeConfig } from './runtimeConfig';

test('migrateStudioConfig copies legacy Studio files into workdir state', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'pinpawo-studio-migrate-'));
  const sourceRoot = path.join(root, 'legacy');
  const workdir = path.join(root, 'workdir');
  const runtimeConfig = runtimeConfigFor(workdir);
  const studioSource = path.join(sourceRoot, 'studio.json');
  const petsSource = path.join(sourceRoot, 'pets');
  const wikiSource = path.join(sourceRoot, 'studio-wiki');
  await fs.mkdir(petsSource, { recursive: true });
  await fs.mkdir(wikiSource, { recursive: true });
  await fs.writeFile(studioSource, '{"studioId":"legacy"}', 'utf8');
  await fs.writeFile(path.join(petsSource, 'planner.json'), '{"petId":"planner"}', 'utf8');
  await fs.writeFile(path.join(wikiSource, 'memory.md'), 'old memory', 'utf8');

  const plan = await migrateStudioConfig({}, {
    runtimeConfig,
    sources: {
      studioConfigPath: studioSource,
      petsDir: petsSource,
      studioWikiBaseDir: wikiSource,
    },
  });

  assert.deepEqual(plan.entries.map((entry) => entry.status), ['copied', 'copied', 'copied']);
  assert.equal(await fs.readFile(runtimeConfig.studioConfigPath, 'utf8'), '{"studioId":"legacy"}');
  assert.equal(await fs.readFile(path.join(runtimeConfig.petsDir, 'planner.json'), 'utf8'), '{"petId":"planner"}');
  assert.equal(await fs.readFile(path.join(runtimeConfig.studioWikiBaseDir, 'memory.md'), 'utf8'), 'old memory');
  assert.match(formatStudioMigratePlan(plan), /Legacy files are left in place/);
});

test('migrateStudioConfig skips existing targets unless force is set', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'pinpawo-studio-migrate-'));
  const sourceRoot = path.join(root, 'legacy');
  const workdir = path.join(root, 'workdir');
  const runtimeConfig = runtimeConfigFor(workdir);
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.mkdir(runtimeConfig.stateRoot, { recursive: true });
  const studioSource = path.join(sourceRoot, 'studio.json');
  await fs.writeFile(studioSource, '{"studioId":"legacy"}', 'utf8');
  await fs.writeFile(runtimeConfig.studioConfigPath, '{"studioId":"current"}', 'utf8');

  const skipped = await migrateStudioConfig({}, {
    runtimeConfig,
    sources: {
      studioConfigPath: studioSource,
      petsDir: path.join(sourceRoot, 'missing-pets'),
      studioWikiBaseDir: path.join(sourceRoot, 'missing-wiki'),
    },
  });
  assert.equal(skipped.entries[0]?.status, 'skipped-existing');
  assert.equal(await fs.readFile(runtimeConfig.studioConfigPath, 'utf8'), '{"studioId":"current"}');

  const forced = await migrateStudioConfig({ force: true }, {
    runtimeConfig,
    sources: {
      studioConfigPath: studioSource,
      petsDir: path.join(sourceRoot, 'missing-pets'),
      studioWikiBaseDir: path.join(sourceRoot, 'missing-wiki'),
    },
  });
  assert.equal(forced.entries[0]?.status, 'copied');
  assert.equal(await fs.readFile(runtimeConfig.studioConfigPath, 'utf8'), '{"studioId":"legacy"}');
});

function runtimeConfigFor(workdir: string): LocalAgentRuntimeConfig {
  const stateRoot = path.join(workdir, '.pinpawo');
  return {
    workdir,
    stateRoot,
    studioConfigPath: path.join(stateRoot, 'studio.json'),
    studioDueRunsPath: path.join(stateRoot, 'studio-due-runs.json'),
    petsDir: path.join(stateRoot, 'pets'),
    studioWikiBaseDir: path.join(stateRoot, 'studio-wiki'),
    checkpointPath: path.join(stateRoot, 'checkpoints.json'),
    tuiCheckpointPath: path.join(stateRoot, 'checkpoints-tui.json'),
    tuiSessionPath: path.join(stateRoot, 'tui-sessions.json'),
    capabilityArtifactRoot: path.join(stateRoot, 'capability-artifacts'),
  };
}
