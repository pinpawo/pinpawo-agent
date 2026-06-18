import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildLocalAgentRuntimeConfig, resolveUserDir } from './runtimeConfig';

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
    petsDir: '/tmp/pinpawo-workdir/.pinpawo/pets',
    studioWikiBaseDir: '/tmp/pinpawo-workdir/.pinpawo/studio-wiki',
    checkpointPath: '/tmp/pinpawo-workdir/.pinpawo/checkpoints.json',
    tuiCheckpointPath: '/tmp/pinpawo-workdir/.pinpawo/checkpoints-tui.json',
    tuiSessionPath: '/tmp/pinpawo-workdir/.pinpawo/tui-sessions.json',
    capabilityArtifactRoot: '/tmp/pinpawo-workdir/.pinpawo/capability-artifacts',
  });
});
