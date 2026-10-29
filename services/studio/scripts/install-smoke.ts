import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startPackageRegistry, type RegistryPackage } from './packageRegistry';

const execFileAsync = promisify(execFile);
const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(studioRoot, '..', '..');
const packageRoots = [
  resolve(workspaceRoot, 'packages', 'agent-contracts'),
  resolve(workspaceRoot, 'packages', 'agent-session'),
  resolve(workspaceRoot, 'packages', 'pet-agent'),
  resolve(workspaceRoot, 'toolkits', 'browser'),
  resolve(workspaceRoot, 'services', 'host'),
  resolve(workspaceRoot, 'packages', 'studio'),
  studioRoot,
  resolve(workspaceRoot, 'plugins', 'studio-http'),
  resolve(workspaceRoot, 'plugins', 'channel'),
  resolve(workspaceRoot, 'plugins', 'scheduler'),
  resolve(workspaceRoot, 'plugins', 'notice'),
  resolve(workspaceRoot, 'plugins', 'project-files'),
  resolve(workspaceRoot, 'plugins', 'trigger'),
];
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error('Run this smoke through npm so npm_execpath is available.');
}

const tempRoot = await mkdtemp(join(tmpdir(), 'pinpawo-studio-install-smoke-'));
const artifactDir = join(tempRoot, 'artifacts');
const consumerDir = join(tempRoot, 'consumer');
const smokeHome = join(tempRoot, 'home');
const cacheDir = process.env.CI
  ? undefined
  : join(workspaceRoot, 'node_modules', '.cache', 'pinpawo-studio-install-smoke-npm');

let registry: Awaited<ReturnType<typeof startPackageRegistry>> | undefined;

try {
  const installedBin = join(
    consumerDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'pinpawo-studio.cmd' : 'pinpawo-studio',
  );
  await Promise.all([
    mkdir(artifactDir, { recursive: true }),
    mkdir(consumerDir, { recursive: true }),
    mkdir(join(smokeHome, '.pinpawo'), { recursive: true }),
    ...(cacheDir ? [mkdir(cacheDir, { recursive: true })] : []),
  ]);
  await writeFile(join(smokeHome, '.pinpawo', 'local-server-token'), 'studio-install-smoke-token\n');
  await writeFile(join(smokeHome, '.pinpawo', 'config.json'), JSON.stringify({
    models: {
      version: 1,
      defaultProfileId: 'smoke',
      profiles: {
        smoke: {
          id: 'smoke', label: 'Smoke', provider: 'openai', model: 'smoke-model',
          baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'smoke-test-key',
          contextWindowTokens: 32_000, inputModalities: ['text'],
        },
      },
    },
  }));
  await writeFile(join(consumerDir, 'package.json'), `${JSON.stringify({
    name: 'pinpawo-studio-install-smoke',
    private: true,
    version: '0.0.0',
    type: 'module',
  }, null, 2)}\n`);

  const packed = await Promise.all(
    packageRoots.map((packageRoot) => packPackage(packageRoot, artifactDir)),
  );
  registry = await startPackageRegistry(packed);
  const distribution = packed.find(({ manifest }) => manifest.name === '@pinpawo/studio');
  assert.ok(distribution);
  await runNpm([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--loglevel=verbose',
    '--timing',
    '--save-exact',
    '--registry',
    registry.url,
    distribution.path,
  ], consumerDir, 'install only the complete Studio entry', 600_000);
  const consumer = JSON.parse(await readFile(join(consumerDir, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(consumer.dependencies), ['@pinpawo/studio']);
  for (const entry of packed) {
    if (entry !== distribution) assert.ok(registry.requested.has(entry.manifest.name), entry.manifest.name);
  }

  const installedStudio = join(consumerDir, 'node_modules', '@pinpawo', 'studio');
  const installedPackage = JSON.parse(
    await readFile(join(installedStudio, 'package.json'), 'utf8'),
  ) as {
    name?: unknown;
    private?: unknown;
    bin?: Record<string, unknown>;
  };
  assert.equal(installedPackage.name, '@pinpawo/studio');
  assert.notEqual(installedPackage.private, true);
  assert.equal(installedPackage.bin?.['pinpawo-studio'], 'dist/cli.js');

  await Promise.all([
    access(join(installedStudio, 'dist', 'index.js')),
    access(join(installedStudio, 'dist', 'index.d.ts')),
    access(join(installedStudio, 'dist', 'cli.js')),
    access(installedBin),
    access(join(consumerDir, 'node_modules', '@pinpawo', 'studio-core', 'templates', 'default', 'studio.json')),
    access(join(consumerDir, 'node_modules', '@pinpawo', 'studio-core', 'templates', 'default', 'wiki', 'PROJECT.md')),
  ]);

  const imported = await runProcess(process.execPath, [
    '--input-type=module',
    '--eval',
    "const studio = await import('@pinpawo/studio'); if (typeof studio.StudioHost !== 'function') throw new Error('StudioHost export missing');",
  ], consumerDir, 'import installed @pinpawo/studio', 30_000);
  assert.equal(imported.stderr, '');

  const installedChannel = join(consumerDir, 'node_modules', '@pinpawo-plugin', 'channel');
  await Promise.all([
    access(join(installedChannel, 'dist', 'index.js')),
    access(join(installedChannel, 'dist', 'index.d.ts')),
  ]);
  await runProcess(process.execPath, [
    '--input-type=module',
    '--eval',
    "const channel = await import('@pinpawo-plugin/channel'); if (typeof channel.createChannelPlugin !== 'function' || typeof channel.ChannelService !== 'function') throw new Error('Channel exports missing');",
  ], consumerDir, 'import installed @pinpawo-plugin/channel', 30_000);

  const cli = process.platform === 'win32'
    ? await runProcess(
      process.execPath,
      [join(installedStudio, 'dist', 'cli.js'), '--help'],
      consumerDir,
      'run installed pinpawo-studio CLI',
      30_000,
    )
    : await runProcess(
      installedBin,
      ['--help'],
      consumerDir,
      'run installed pinpawo-studio CLI',
      30_000,
    );
  assert.match(cli.stdout, /Usage: pinpawo-studio/);
  assert.equal(cli.stderr, '');

  const initializedWorkdir = join(tempRoot, 'initialized-workdir');
  const initialized = process.platform === 'win32'
    ? await runProcess(
      process.execPath,
      [join(installedStudio, 'dist', 'cli.js'), 'init', '--workdir', initializedWorkdir],
      consumerDir,
      'initialize installed Studio workdir',
      30_000,
      { HOME: smokeHome, USERPROFILE: smokeHome },
    )
    : await runProcess(
      installedBin,
      ['init', '--workdir', initializedWorkdir],
      consumerDir,
      'initialize installed Studio workdir',
      30_000,
      { HOME: smokeHome, USERPROFILE: smokeHome },
    );
  assert.match(initialized.stdout, /Initialized Studio workdir/);
  assert.equal(initialized.stderr, '');
  await Promise.all([
    access(join(initializedWorkdir, '.pinpawo', 'studio.json')),
    access(join(initializedWorkdir, '.pinpawo', 'pets', 'executor.json')),
  ]);

  // Wiki must be under this smoke's isolated HOME, not the test runner's real home or workdir.
  const configPath = join(initializedWorkdir, '.pinpawo', 'studio.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const wikiDirectory = config.plugins.find(({ id }: { id: string }) => id === '@pinpawo-plugin/project-files')?.options?.wikiDirectory;
  assert.equal(typeof wikiDirectory, 'string');
  assert.ok(isAbsolute(wikiDirectory));
  const wikiRelative = relative(join(smokeHome, '.pinpawo', 'studios'), wikiDirectory);
  assert.ok(wikiRelative && !isAbsolute(wikiRelative) && wikiRelative !== '..' && !wikiRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
  await access(join(wikiDirectory, 'PROJECT.md'));
  await assert.rejects(access(join(initializedWorkdir, 'wiki', 'PROJECT.md')), /ENOENT/);

  // Preserve the shipped Plugin set and settings; only use a free HTTP test port.
  config.plugins.find(({ id }: { id: string }) => id === '@pinpawo-plugin/studio-http').options.port = 0;
  await writeFile(configPath, JSON.stringify(config));

  const resolvedKickstart = await runProcess(process.execPath, [
    '--input-type=module',
    '--eval',
    [
      "const studio = await import('@pinpawo/studio');",
      'const workdir = process.env.PINPAWO_SMOKE_WORKDIR;',
      "if (!workdir) throw new Error('missing smoke workdir');",
      'const configuration = await studio.resolveStudioHostConfig({',
      '  workdir,',
      '  resolvePlugin: studio.createInstalledStudioPluginResolver({ workdir }),',
      '});',
      'const names = configuration.plugins.map(({ name }) => name);',
      "const expected = ['http', 'notice', 'channel', 'scheduler', 'project-files', 'trigger'];",
      "if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`unexpected Plugins: ${JSON.stringify(names)}`);",
      'await studio.runStudioHostProcess({ workdir, agentSessionPort: 0 }, {',
      '  writeOutput: () => undefined,',
      '  startHost: async (options) => {',
      '    const running = await studio.startStudioHost({',
      '      ...options, resolveStudioHostConfig: async () => configuration,',
      '    });',
      '    try {',
      "      const address = configuration.plugins.find(({ name }) => name === 'http').address();",
      "      if (!address) throw new Error('HTTP Plugin did not start');",
      "      for (const route of ['/pets', '/channels', '/notices', '/scheduler', '/triggers', '/knowledge']) {",
      '        const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {',
      "          headers: { authorization: 'Bearer studio-install-smoke-token' },",
      '        });',
      '        if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);',
      '        await response.json();',
      '      }',
      '    } finally { running.close(); await running.closed; }',
      '    return running;',
      '  },',
      '});',
      "process.stdout.write(`${names.join(',')}\\n`);",
    ].join('\n'),
  ], consumerDir, 'resolve initialized Studio workdir Plugins', 30_000, {
    PINPAWO_SMOKE_WORKDIR: initializedWorkdir,
    HOME: smokeHome,
    USERPROFILE: smokeHome,
    PINPAWO_WORKSPACES_DIR: join(smokeHome, 'workspaces'),
    LANGCHAIN_TRACING_V2: 'false',
    LANGSMITH_TRACING: 'false',
  });
  assert.ok(resolvedKickstart.stdout.trim().endsWith('http,notice,channel,scheduler,project-files,trigger'));
  process.stdout.write('[studio:install-smoke] installed library and CLI passed\n');
} finally {
  await registry?.close();
  await rm(tempRoot, { recursive: true, force: true });
}

async function packPackage(packageRoot: string, destination: string) {
  const result = await runNpm([
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    destination,
  ], packageRoot, `pack ${packageRoot}`, 60_000);
  const payload = JSON.parse(result.stdout) as Array<{ filename: string; integrity: string; shasum: string }>;
  assert.equal(typeof payload[0]?.filename, 'string');
  return {
    ...payload[0]!,
    manifest: JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')),
    path: join(destination, payload[0]!.filename),
  } as RegistryPackage;
}

async function runNpm(
  args: string[],
  cwd: string,
  label: string,
  timeoutMs: number,
) {
  return runProcess(process.execPath, [npmCli!, ...args], cwd, label, timeoutMs, {
    ...(cacheDir ? { npm_config_cache: cacheDir } : {}),
  });
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  label: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = {},
) {
  process.stdout.write(`[studio:install-smoke] ${label}...\n`);
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    });
    process.stdout.write(`[studio:install-smoke] ${label} passed\n`);
    return result;
  } catch (error) {
    const failure = error as Error & {
      code?: number | string;
      signal?: NodeJS.Signals;
      stdout?: string;
      stderr?: string;
    };
    assert.fail([
      `${label} failed.`,
      `${command} ${args.join(' ')}`,
      `code=${String(failure.code)} signal=${String(failure.signal)}`,
      failure.stderr || failure.stdout || failure.message,
    ].join('\n'));
  }
}
