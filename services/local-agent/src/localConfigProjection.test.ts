import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
    serverMode: 'chat',
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
  const deps = { ...createDeps('/tmp/stale-workdir'), runtimeConfig };

  const runtime = buildLocalRuntimeProjection(deps);
  const http = buildLocalHttpRuntimeProjection(deps);

  assert.equal(runtime.workdir, runtimeConfig.workdir);
  assert.equal(http.local_agent_version, readLocalAgentPackageVersion());
  assert.equal(http.workdir, runtime.workdir);
  assert.equal(http.workspace_id, runtime.workspaceId);
  assert.equal(http.state_root, runtime.stateRoot);
  assert.equal(runtime.contextCompactionWatermarkTokens, 24_000);
  assert.equal(http.context_compaction_watermark_tokens, 24_000);
  assert.equal('studio_config_path' in http, false);
  assert.equal('pets_dir' in http, false);
});

test('runtime projection excludes output and thinking reserves before context compaction', () => {
  const deps: LocalServerDeps = {
    serverMode: 'chat',
    actorId: 'pet-test',
    ...createTestModelServerDeps({
      model: 'qwen3.8-max',
      contextWindowTokens: 983_616,
      maxOutputTokens: 131_072,
    }),
    workdir: '/tmp/pinpawo-qwen-runtime',
  };

  assert.equal(
    buildLocalRuntimeProjection(deps).contextCompactionWatermarkTokens,
    627_120,
  );
});

test('projection without runtime config keeps workspace state optional', () => {
  const runtime = buildLocalRuntimeProjection(createDeps('/tmp/runtime-without-config'));

  assert.equal(runtime.workdir, '/tmp/runtime-without-config');
  assert.equal(runtime.stateRoot, undefined);
});

test('session projection surfaces an unavailable selected profile without fallback', () => {
  const deps = createDeps('/tmp/runtime-unavailable-profile');
  const runtime = buildLocalRuntimeProjection(deps, 'removed-profile');

  assert.equal(runtime.modelProfileId, 'removed-profile');
  assert.equal(runtime.modelProfileAvailable, false);
  assert.equal(runtime.model, undefined);
  assert.match(runtime.modelProfileIssues[0] ?? '', /Unknown model profile/);
});

test('runtime projection surfaces the startup-decided chat mode', () => {
  const deps = createDeps('/tmp/pinpawo-mode-chat-projection');

  assert.equal(buildLocalRuntimeProjection(deps).serverMode, 'chat');
  assert.equal(buildLocalHttpRuntimeProjection(deps).server_mode, 'chat');
});

test('chat projection omits Studio-specific fields', () => {
  const http = buildLocalHttpRuntimeProjection(createDeps('/tmp/pinpawo-mode-chat'));

  assert.equal('studio_mode' in http, false);
});
