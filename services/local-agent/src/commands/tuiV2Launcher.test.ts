import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildTuiV2LaunchArgs,
  findLocalAgentPackageRoot,
  parseTuiV2DistributionManifest,
  resolveTuiV2LaunchPlan,
  runTuiV2,
  verifyTuiV2DistributionEntry,
} from './tuiV2Launcher';

const LOCAL_AGENT_ROOT = '/workspace/services/local-agent';
const WORKSPACE_ROOT = '/workspace';
const TUI_ROOT = join(WORKSPACE_ROOT, 'services', 'tui');
const WORKSPACE_PACKAGE = join(WORKSPACE_ROOT, 'package.json');
const WORKSPACE_MANIFEST = JSON.stringify({
  workspaces: [
    'packages/*',
    'services/local-agent',
    'services/tui',
  ],
});
const DISTRIBUTION_ENTRY = Buffer.from('pinpawo-tui-bundle');
const VALID_DISTRIBUTION_MANIFEST_VALUE = {
  schemaVersion: 1,
  format: 'bun-bundle',
  entry: 'main.js',
  tuiVersion: '0.1.0',
  bunVersion: '1.3.14',
  openTuiVersion: '0.4.5',
  bytes: DISTRIBUTION_ENTRY.byteLength,
  sha256: createHash('sha256').update(DISTRIBUTION_ENTRY).digest('hex'),
} as const;
const VALID_DISTRIBUTION_MANIFEST = JSON.stringify(
  VALID_DISTRIBUTION_MANIFEST_VALUE,
);

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
    pathExists: (path) => (
      path === WORKSPACE_PACKAGE
      || path === workspace
    ),
    readTextFile: () => WORKSPACE_MANIFEST,
  }), {
    source: 'workspace-binary',
    command: workspace,
    args: [],
  });
});

test('v2 launcher parses only the supported distribution manifest', () => {
  assert.deepEqual(
    parseTuiV2DistributionManifest(VALID_DISTRIBUTION_MANIFEST),
    JSON.parse(VALID_DISTRIBUTION_MANIFEST),
  );
  assert.equal(parseTuiV2DistributionManifest('{'), null);
  assert.equal(parseTuiV2DistributionManifest(JSON.stringify({
    ...JSON.parse(VALID_DISTRIBUTION_MANIFEST),
    entry: '../main.js',
  })), null);
  assert.equal(parseTuiV2DistributionManifest(JSON.stringify({
    ...JSON.parse(VALID_DISTRIBUTION_MANIFEST),
    bytes: 0,
  })), null);
});

test('v2 launcher verifies distribution bytes and digest', () => {
  assert.equal(verifyTuiV2DistributionEntry(
    VALID_DISTRIBUTION_MANIFEST_VALUE,
    DISTRIBUTION_ENTRY,
  ), true);
  assert.equal(verifyTuiV2DistributionEntry(
    VALID_DISTRIBUTION_MANIFEST_VALUE,
    Buffer.from('truncated'),
  ), false);
  assert.equal(verifyTuiV2DistributionEntry(
    {
      ...VALID_DISTRIBUTION_MANIFEST_VALUE,
      sha256: 'a'.repeat(64),
    },
    DISTRIBUTION_ENTRY,
  ), false);
});

test('v2 launcher runs workspace source with a configured or local Bun', () => {
  const source = join(TUI_ROOT, 'src', 'main.ts');
  assert.deepEqual(resolveTuiV2LaunchPlan({
    localAgentRoot: LOCAL_AGENT_ROOT,
    env: {
      PINPAWO_BUN_BIN: '/opt/bun/bin/bun',
    },
    pathExists: (path) => (
      path === WORKSPACE_PACKAGE
      || path === source
    ),
    readTextFile: () => WORKSPACE_MANIFEST,
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
      path === WORKSPACE_PACKAGE
      || path === source
      || path === workspaceBun
      || path === workspaceBinary
    ),
    readTextFile: () => WORKSPACE_MANIFEST,
  }), {
    source: 'workspace-source',
    command: workspaceBun,
    args: ['run', source],
  });
});

test('v2 launcher runs an installed distribution with its local Bun', () => {
  const installedRoot = '/app/node_modules/pinpawo';
  const manifest = join(installedRoot, 'dist', 'tui', 'manifest.json');
  const entry = join(installedRoot, 'dist', 'tui', 'main.js');
  const packageBun = join(
    installedRoot,
    '..',
    '.bin',
    'bun',
  );
  const hostPackage = '/app/package.json';
  const hostTuiSource = '/app/services/tui/src/main.ts';
  const paths = new Set([
    manifest,
    entry,
    packageBun,
    hostPackage,
    hostTuiSource,
  ]);
  assert.deepEqual(resolveTuiV2LaunchPlan({
    localAgentRoot: installedRoot,
    env: {},
    platform: 'darwin',
    arch: 'arm64',
    pathExists: (path) => paths.has(path),
    readTextFile: (path) => path === manifest
      ? VALID_DISTRIBUTION_MANIFEST
      : JSON.stringify({ name: 'consumer-app' }),
    readBinaryFile: () => DISTRIBUTION_ENTRY,
  }), {
    source: 'packaged-bundle',
    command: packageBun,
    args: ['run', entry],
  });
});

test('v2 launcher forwards only explicit public modes to the TUI process', () => {
  const plan = {
    source: 'packaged-bundle' as const,
    command: '/app/node_modules/.bin/bun',
    args: ['run', '/app/node_modules/pinpawo/dist/tui/main.js'],
  };

  assert.deepEqual(buildTuiV2LaunchArgs(plan), plan.args);
  assert.deepEqual(buildTuiV2LaunchArgs(plan, { check: true }), [
    ...plan.args,
    '--version',
  ]);
  assert.deepEqual(buildTuiV2LaunchArgs(plan, { qa: true }), [
    ...plan.args,
    '--demo-qa',
  ]);
  assert.throws(
    () => buildTuiV2LaunchArgs(plan, { check: true, qa: true }),
    /mutually exclusive/,
  );
});

test('v2 launcher resolves the installed Bun runtime across supported platforms', () => {
  const installedRoot = '/app/node_modules/pinpawo';
  const manifest = join(installedRoot, 'dist', 'tui', 'manifest.json');
  const entry = join(installedRoot, 'dist', 'tui', 'main.js');
  const cases: Array<{
    platform: NodeJS.Platform;
    arch: string;
    bunPath: string[];
  }> = [
    { platform: 'darwin', arch: 'x64', bunPath: ['.bin', 'bun'] },
    { platform: 'darwin', arch: 'arm64', bunPath: ['.bin', 'bun'] },
    { platform: 'linux', arch: 'x64', bunPath: ['.bin', 'bun'] },
    { platform: 'linux', arch: 'arm64', bunPath: ['.bin', 'bun'] },
    { platform: 'win32', arch: 'x64', bunPath: ['bun', 'bin', 'bun.exe'] },
    { platform: 'win32', arch: 'arm64', bunPath: ['bun', 'bin', 'bun.exe'] },
  ];

  for (const item of cases) {
    const packageBun = join(
      installedRoot,
      '..',
      ...item.bunPath,
    );
    assert.deepEqual(resolveTuiV2LaunchPlan({
      localAgentRoot: installedRoot,
      env: {},
      platform: item.platform,
      arch: item.arch,
      pathExists: (path) => (
        path === manifest
        || path === entry
        || path === packageBun
      ),
      readTextFile: () => VALID_DISTRIBUTION_MANIFEST,
      readBinaryFile: () => DISTRIBUTION_ENTRY,
    }), {
      source: 'packaged-bundle',
      command: packageBun,
      args: ['run', entry],
    }, `${item.platform}-${item.arch}`);
  }
});

test('v2 launcher rejects an invalid or incomplete distribution', () => {
  const manifest = join(LOCAL_AGENT_ROOT, 'dist', 'tui', 'manifest.json');
  assert.throws(
    () => resolveTuiV2LaunchPlan({
      localAgentRoot: LOCAL_AGENT_ROOT,
      env: {},
      pathExists: (path) => path === manifest,
      readTextFile: () => '{}',
    }),
    /distribution manifest is invalid/,
  );
  assert.throws(
    () => resolveTuiV2LaunchPlan({
      localAgentRoot: LOCAL_AGENT_ROOT,
      env: {},
      pathExists: (path) => path === manifest,
      readTextFile: () => VALID_DISTRIBUTION_MANIFEST,
    }),
    /distribution entry is missing/,
  );
  assert.throws(
    () => resolveTuiV2LaunchPlan({
      localAgentRoot: LOCAL_AGENT_ROOT,
      env: {},
      pathExists: (path) => (
        path === manifest
        || path === join(LOCAL_AGENT_ROOT, 'dist', 'tui', 'main.js')
      ),
      readTextFile: () => VALID_DISTRIBUTION_MANIFEST,
      readBinaryFile: () => Buffer.from('corrupted'),
    }),
    /failed integrity verification/,
  );
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
