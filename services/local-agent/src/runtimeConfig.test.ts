import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  attachWorkspaceConfig,
  buildLocalAgentRuntimeConfig,
  resolveHostCheckpointPath,
  buildWorkspaceRuntimeConfig,
  deriveWorkspaceId,
  deriveWorkspaceName,
  findLegacyLocalAgentState,
  resolveDefaultWorkdir,
  resolveUserDir,
} from './runtimeConfig';

test('resolveUserDir expands home and resolves relative paths from process cwd', () => {
  assert.equal(resolveUserDir('~'), homedir());
  assert.equal(resolveUserDir('~/pinpawo-test'), resolve(homedir(), 'pinpawo-test'));
  assert.equal(resolveUserDir('relative-workdir'), resolve(process.cwd(), 'relative-workdir'));
  assert.equal(resolveUserDir('/tmp/pinpawo-workdir'), '/tmp/pinpawo-workdir');
});

test('buildLocalAgentRuntimeConfig scopes runtime state under workdir .pinpawo', () => {
  const runtimeConfig = buildLocalAgentRuntimeConfig('/tmp/pinpawo-workdir');

  assert.deepEqual(runtimeConfig, {
    workdir: '/tmp/pinpawo-workdir',
    stateRoot: '/tmp/pinpawo-workdir/.pinpawo',
    studioConfigPath: '/tmp/pinpawo-workdir/.pinpawo/studio.json',
    studioDueRunsPath: '/tmp/pinpawo-workdir/.pinpawo/studio-due-runs.json',
    petsDir: '/tmp/pinpawo-workdir/.pinpawo/pets',
    studioWikiBaseDir: '/tmp/pinpawo-workdir/.pinpawo/studio-wiki',
    checkpointPath: '/tmp/pinpawo-workdir/.pinpawo/checkpoints-capability-v2.json',
    tuiCheckpointPath: '/tmp/pinpawo-workdir/.pinpawo/checkpoints-tui-capability-v2.json',
    tuiSessionPath: '/tmp/pinpawo-workdir/.pinpawo/tui-sessions-capability-v2.json',
    capabilityArtifactRoot: '/tmp/pinpawo-workdir/.pinpawo/capability-artifacts',
  });
  assert.equal(Object.isFrozen(runtimeConfig), true);
  assert.equal(
    resolveHostCheckpointPath(runtimeConfig, 'studio'),
    '/tmp/pinpawo-workdir/.pinpawo/checkpoints-studio-capability-v2.json',
  );
});

test('resolveDefaultWorkdir prefers env, then stored config, then process cwd', () => {
  assert.equal(
    resolveDefaultWorkdir({ PINPAWO_WORKDIR: '/tmp/from-env' }, { workdir: '/tmp/from-stored' }),
    '/tmp/from-env',
  );
  assert.equal(
    resolveDefaultWorkdir({}, { workdir: '/tmp/from-stored' }),
    '/tmp/from-stored',
  );
  assert.equal(
    resolveDefaultWorkdir({}, {}),
    process.cwd(),
  );
});

test('buildWorkspaceRuntimeConfig adds stable workspace identity over workdir state', () => {
  const runtimeConfig = buildWorkspaceRuntimeConfig({
    workdir: '/tmp/pinpawo-workspace',
    workspaceName: 'PinPawo Agent',
  });

  assert.equal(runtimeConfig.workdir, '/tmp/pinpawo-workspace');
  assert.deepEqual(runtimeConfig.workspace, {
    id: deriveWorkspaceId('/tmp/pinpawo-workspace'),
    name: 'PinPawo Agent',
    rootPath: '/tmp/pinpawo-workspace',
  });
  assert.equal(Object.isFrozen(runtimeConfig), true);
  assert.equal(Object.isFrozen(runtimeConfig.workspace), true);
});

test('attachWorkspaceConfig honors explicit workspace id and derives readable names', () => {
  const runtimeConfig = attachWorkspaceConfig(
    buildLocalAgentRuntimeConfig('/tmp/pinpawo-readable-workspace'),
    { workspaceId: 'workspace-123' },
  );

  assert.deepEqual(runtimeConfig.workspace, {
    id: 'workspace-123',
    name: deriveWorkspaceName('/tmp/pinpawo-readable-workspace'),
    rootPath: '/tmp/pinpawo-readable-workspace',
  });
});

test('findLegacyLocalAgentState reports preserved pre-V2 checkpoint and session paths', (t) => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-legacy-state-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const runtimeConfig = buildLocalAgentRuntimeConfig(workdir);
  mkdirSync(join(runtimeConfig.stateRoot, 'checkpoints'), { recursive: true });
  writeFileSync(join(runtimeConfig.stateRoot, 'tui-sessions.json'), '{}');

  assert.deepEqual(findLegacyLocalAgentState(runtimeConfig), [
    join(runtimeConfig.stateRoot, 'checkpoints'),
    join(runtimeConfig.stateRoot, 'tui-sessions.json'),
  ]);
});
