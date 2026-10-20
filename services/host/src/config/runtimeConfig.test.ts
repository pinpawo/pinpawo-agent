import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  attachWorkspaceConfig,
  buildHostRuntimeConfig,
  resolveHostCheckpointPath,
  buildWorkspaceRuntimeConfig,
  deriveWorkspaceId,
  deriveWorkspaceName,
  findLegacyHostState,
  resolveDefaultWorkdir,
  resolveUserDir,
  resolveWorkspaceSessionRoot,
} from './runtimeConfig';

test('resolveUserDir expands home and resolves relative paths from process cwd', () => {
  assert.equal(resolveUserDir('~'), homedir());
  assert.equal(resolveUserDir('~/pinpawo-test'), resolve(homedir(), 'pinpawo-test'));
  assert.equal(resolveUserDir('relative-workdir'), resolve(process.cwd(), 'relative-workdir'));
  assert.equal(resolveUserDir('/tmp/pinpawo-workdir'), '/tmp/pinpawo-workdir');
});

test('buildHostRuntimeConfig keeps project config in the workdir and sessions under the workspaces dir', () => {
  const runtimeConfig = buildHostRuntimeConfig('/tmp/pinpawo-workdir');
  const sessionRoot = resolveWorkspaceSessionRoot('/tmp/pinpawo-workdir');

  assert.deepEqual(runtimeConfig, {
    workdir: '/tmp/pinpawo-workdir',
    stateRoot: '/tmp/pinpawo-workdir/.pinpawo',
    sessionRoot,
    checkpointPath: join(sessionRoot, 'checkpoints-capability-v5.json'),
    tuiCheckpointPath: join(sessionRoot, 'checkpoints-tui-capability-v5.json'),
    tuiSessionPath: join(sessionRoot, 'tui-sessions-capability-v5.json'),
    petsDir: '/tmp/pinpawo-workdir/.pinpawo/pets',
    capabilityArtifactRoot: join(sessionRoot, 'capability-artifacts'),
  });
  assert.equal(Object.isFrozen(runtimeConfig), true);
  assert.equal(
    resolveHostCheckpointPath(runtimeConfig, 'studio'),
    join(sessionRoot, 'checkpoints-studio-capability-v5.json'),
  );
});

test('resolveWorkspaceSessionRoot gives each workdir its own directory under ~/.pinpawo/workspaces', () => {
  const id = deriveWorkspaceId('/tmp/pinpawo-workdir');
  assert.equal(
    resolveWorkspaceSessionRoot('/tmp/pinpawo-workdir', {}),
    join(homedir(), '.pinpawo', 'workspaces', id),
  );
  assert.equal(
    resolveWorkspaceSessionRoot('/tmp/pinpawo-workdir', { PINPAWO_WORKSPACES_DIR: '/tmp/sessions' }),
    join('/tmp/sessions', id),
  );
  assert.notEqual(
    resolveWorkspaceSessionRoot('/tmp/pinpawo-workdir', {}),
    resolveWorkspaceSessionRoot('/tmp/pinpawo-other', {}),
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
    buildHostRuntimeConfig('/tmp/pinpawo-readable-workspace'),
    { workspaceId: 'workspace-123' },
  );

  assert.deepEqual(runtimeConfig.workspace, {
    id: 'workspace-123',
    name: deriveWorkspaceName('/tmp/pinpawo-readable-workspace'),
    rootPath: '/tmp/pinpawo-readable-workspace',
  });
});

test('findLegacyHostState reports session state left in the workdir but not project config', (t) => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-legacy-state-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const runtimeConfig = buildHostRuntimeConfig(workdir);
  assert.deepEqual(findLegacyHostState(runtimeConfig), []);
  for (const dir of ['checkpoints', 'checkpoints-tui-capability-v4', 'capability-artifacts', 'resident-sessions', 'pets', 'studio']) {
    mkdirSync(join(runtimeConfig.stateRoot, dir), { recursive: true });
  }
  writeFileSync(join(runtimeConfig.stateRoot, 'tui-sessions-capability-v4.json'), '{}');
  writeFileSync(join(runtimeConfig.stateRoot, 'studio.json'), '{}');

  assert.deepEqual(findLegacyHostState(runtimeConfig), [
    'capability-artifacts',
    'checkpoints',
    'checkpoints-tui-capability-v4',
    'resident-sessions',
    'tui-sessions-capability-v4.json',
  ].map((name) => join(runtimeConfig.stateRoot, name)));
});
