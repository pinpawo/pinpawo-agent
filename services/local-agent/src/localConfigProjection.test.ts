import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildLocalHttpRuntimeProjection,
  buildLocalRuntimeProjection,
} from './localConfigProjection';
import { readLocalAgentPackageVersion } from './packageVersion';
import {
  getLocalServerWorkdir,
  normalizeLocalServerDeps,
  type LocalServerDeps,
} from './localServerTypes';
import { buildWorkspaceRuntimeConfig } from './runtimeConfig';
import { createTestModelServerDeps } from './testing/modelProfiles';

function createDeps(workdir: string): LocalServerDeps {
  return {
    actorId: 'pet-test',
    ...createTestModelServerDeps({ contextWindowTokens: 32000 }),
    workdir,
  };
}

test('normalizeLocalServerDeps creates one workspace runtime config and aligns workdir', () => {
  const deps = normalizeLocalServerDeps(createDeps('/tmp/pinpawo-normalized-workdir'));

  assert.equal(deps.workdir, deps.runtimeConfig.workdir);
  assert.equal(deps.runtimeConfig.workspace?.rootPath, deps.workdir);
  assert.equal(Object.isFrozen(deps.runtimeConfig), true);
  assert.equal(Object.isFrozen(deps.runtimeConfig.workspace), true);
});

test('legacy workdir reads remain unchanged until the server boundary normalizes them', () => {
  assert.equal(getLocalServerWorkdir(createDeps('relative-workdir')), 'relative-workdir');
});

test('HTTP and TUI projections expose the same normalized runtime values', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-runtime-projection-'));
  const runtimeConfig = buildWorkspaceRuntimeConfig({ workdir });
  mkdirSync(runtimeConfig.stateRoot, { recursive: true });
  writeFileSync(runtimeConfig.studioConfigPath, '{}');
  const deps = { ...createDeps('/tmp/stale-workdir'), runtimeConfig };

  const runtime = buildLocalRuntimeProjection(deps);
  const http = buildLocalHttpRuntimeProjection(deps);

  assert.equal(runtime.workdir, runtimeConfig.workdir);
  assert.equal(http.local_agent_version, readLocalAgentPackageVersion());
  assert.equal(http.workdir, runtime.workdir);
  assert.equal(http.workspace_id, runtime.workspaceId);
  assert.equal(http.state_root, runtime.stateRoot);
  assert.equal(http.studio_config_path, runtime.studioConfigPath);
  assert.equal(http.studio_due_runs_path, runtime.studioDueRunsPath);
});

test('projection without runtime config does not synthesize Studio paths', () => {
  const runtime = buildLocalRuntimeProjection(createDeps('/tmp/runtime-without-config'));

  assert.equal(runtime.workdir, '/tmp/runtime-without-config');
  assert.equal(runtime.stateRoot, undefined);
  assert.equal(runtime.studioConfigPath, undefined);
});

test('session projection surfaces an unavailable selected profile without fallback', () => {
  const deps = createDeps('/tmp/runtime-unavailable-profile');
  const runtime = buildLocalRuntimeProjection(deps, 'removed-profile');

  assert.equal(runtime.modelProfileId, 'removed-profile');
  assert.equal(runtime.modelProfileAvailable, false);
  assert.equal(runtime.model, undefined);
  assert.match(runtime.modelProfileIssues[0] ?? '', /Unknown model profile/);
});
