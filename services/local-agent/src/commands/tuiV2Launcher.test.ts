import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import {
  findLocalAgentPackageRoot,
  resolveTuiV2LaunchPlan,
  runTuiV2,
} from './tuiV2Launcher';

const LOCAL_AGENT_ROOT = '/workspace/services/local-agent';
const WORKSPACE_ROOT = '/workspace';
const TUI_ROOT = join(WORKSPACE_ROOT, 'services', 'tui');

test('v2 launcher prefers an explicit executable override', () => {
  assert.deepEqual(resolveTuiV2LaunchPlan({
    localAgentRoot: LOCAL_AGENT_ROOT,
    env: {
      PINPAWO_TUI_V2_BIN: '/opt/pinpawo/custom-tui',
    },
    pathExists: () => false,
  }), {
    source: 'override',
    command: '/opt/pinpawo/custom-tui',
    args: [],
  });
});

test('v2 launcher selects a packaged binary before workspace assets', () => {
  const packaged = join(
    LOCAL_AGENT_ROOT,
    'dist',
    'tui',
    'pinpawo-tui-darwin-arm64',
  );
  assert.deepEqual(resolveTuiV2LaunchPlan({
    localAgentRoot: LOCAL_AGENT_ROOT,
    env: {},
    platform: 'darwin',
    arch: 'arm64',
    pathExists: (path) => path === packaged,
  }), {
    source: 'packaged-binary',
    command: packaged,
    args: [],
  });

});

test('v2 launcher uses a workspace binary when no local Bun is installed', () => {
  const workspace = join(TUI_ROOT, 'dist', 'pinpawo-tui');
  assert.deepEqual(resolveTuiV2LaunchPlan({
    localAgentRoot: LOCAL_AGENT_ROOT,
    env: {},
    platform: 'darwin',
    arch: 'arm64',
    pathExists: (path) => path === workspace,
  }), {
    source: 'workspace-binary',
    command: workspace,
    args: [],
  });
});

test('v2 launcher runs workspace source with a configured or local Bun', () => {
  const source = join(TUI_ROOT, 'src', 'main.ts');
  assert.deepEqual(resolveTuiV2LaunchPlan({
    localAgentRoot: LOCAL_AGENT_ROOT,
    env: {
      PINPAWO_BUN_BIN: '/opt/bun/bin/bun',
    },
    pathExists: (path) => path === source,
  }), {
    source: 'workspace-source',
    command: '/opt/bun/bin/bun',
    args: ['run', source],
  });

  const workspaceBun = join(WORKSPACE_ROOT, 'node_modules', '.bin', 'bun');
  const workspaceBinary = join(TUI_ROOT, 'dist', 'pinpawo-tui');
  assert.deepEqual(resolveTuiV2LaunchPlan({
    localAgentRoot: LOCAL_AGENT_ROOT,
    env: {},
    pathExists: (path) => (
      path === source
      || path === workspaceBun
      || path === workspaceBinary
    ),
  }), {
    source: 'workspace-source',
    command: workspaceBun,
    args: ['run', source],
  });
});

test('v2 launcher explains when an installed package has no v2 payload', () => {
  assert.throws(
    () => resolveTuiV2LaunchPlan({
      localAgentRoot: LOCAL_AGENT_ROOT,
      env: {},
      pathExists: () => false,
    }),
    /not bundled.*--legacy.*PINPAWO_TUI_V2_BIN/,
  );
});

test('package root discovery accepts source and bundled module locations', () => {
  const packagePath = join(LOCAL_AGENT_ROOT, 'package.json');
  const exists = (path: string) => path === packagePath;
  const read = () => JSON.stringify({ name: 'pinpawo' });

  assert.equal(findLocalAgentPackageRoot(
    join(LOCAL_AGENT_ROOT, 'src', 'commands', 'tuiV2Launcher.ts'),
    exists,
    read,
  ), LOCAL_AGENT_ROOT);
  assert.equal(findLocalAgentPackageRoot(
    join(LOCAL_AGENT_ROOT, 'dist', 'index.js'),
    exists,
    read,
  ), LOCAL_AGENT_ROOT);
});

test('v2 launcher rejects an invalid child working directory before spawning', async () => {
  await assert.rejects(
    runTuiV2({
      workdir: '/definitely/missing/pinpawo-tui-v2-workdir',
    }),
    /TUI workdir is not a directory/,
  );
});
