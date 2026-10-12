import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildLocalRuntimeProjection } from './configProjection';
import type { ServerDeps } from '../serverTypes';
import { buildHostRuntimeConfig, buildWorkspaceRuntimeConfig } from './runtimeConfig';
import { createTestModelServerDeps } from '../testing/modelProfiles';

function createDeps(workdir: string): ServerDeps {
  return {
    petId: 'pet-test',
    ...createTestModelServerDeps({ contextWindowTokens: 32000 }),
    runtimeConfig: buildHostRuntimeConfig(workdir),
  };
}

test('runtime projection exposes normalized workspace runtime values', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-runtime-projection-'));
  const runtimeConfig = buildWorkspaceRuntimeConfig({ workdir });
  const deps = { ...createDeps('/tmp/stale-workdir'), runtimeConfig };

  const runtime = buildLocalRuntimeProjection(deps);

  assert.equal(runtime.workdir, runtimeConfig.workdir);
  assert.equal(runtime.workspaceId, runtimeConfig.workspace?.id);
  assert.equal(runtime.stateRoot, runtimeConfig.stateRoot);
  assert.equal(runtime.contextCompactionWatermarkTokens, 24_000);
  assert.equal('studioConfigPath' in runtime, false);
  assert.equal('petsDir' in runtime, false);
});

test('runtime projection excludes output and thinking reserves before context compaction', () => {
  const deps: ServerDeps = {
    petId: 'pet-test',
    ...createTestModelServerDeps({
      model: 'qwen3.8-max',
      contextWindowTokens: 983_616,
      maxOutputTokens: 131_072,
    }),
    runtimeConfig: buildHostRuntimeConfig('/tmp/pinpawo-qwen-runtime'),
  };

  assert.equal(
    buildLocalRuntimeProjection(deps).contextCompactionWatermarkTokens,
    627_120,
  );
});

test('projection uses explicit runtime paths while workspace metadata remains optional', () => {
  const runtime = buildLocalRuntimeProjection(createDeps('/tmp/runtime-without-config'));

  assert.equal(runtime.workdir, '/tmp/runtime-without-config');
  assert.equal(runtime.stateRoot, '/tmp/runtime-without-config/.pinpawo');
  assert.equal(runtime.workspaceId, undefined);
});

test('session projection surfaces an unavailable selected profile without fallback', () => {
  const deps = createDeps('/tmp/runtime-unavailable-profile');
  const runtime = buildLocalRuntimeProjection(deps, 'removed-profile');

  assert.equal(runtime.modelProfileId, 'removed-profile');
  assert.equal(runtime.modelProfileAvailable, false);
  assert.equal(runtime.model, undefined);
  assert.match(runtime.modelProfileIssues[0] ?? '', /Unknown model profile/);
});
