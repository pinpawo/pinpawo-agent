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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(studioRoot, '..', '..');
const packageRoots = [
  resolve(workspaceRoot, 'packages', 'agent-contracts'),
  resolve(workspaceRoot, 'packages', 'agent-session'),
  resolve(workspaceRoot, 'packages', 'pet-agent'),
  resolve(workspaceRoot, 'services', 'local-agent'),
  studioRoot,
  resolve(workspaceRoot, 'plugins', 'studio-http'),
  resolve(workspaceRoot, 'plugins', 'kanban'),
  resolve(workspaceRoot, 'plugins', 'scheduler'),
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
const cacheDir = process.env.CI
  ? undefined
  : join(workspaceRoot, 'node_modules', '.cache', 'pinpawo-studio-install-smoke-npm');

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
    ...(cacheDir ? [mkdir(cacheDir, { recursive: true })] : []),
  ]);
  await writeFile(join(consumerDir, 'package.json'), `${JSON.stringify({
    name: 'pinpawo-studio-install-smoke',
    private: true,
    version: '0.0.0',
    type: 'module',
  }, null, 2)}\n`);

  const tarballs = await Promise.all(
    packageRoots.map((packageRoot) => packPackage(packageRoot, artifactDir)),
  );
  await runNpm([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--prefer-offline',
    '--save=false',
    ...tarballs,
  ], consumerDir, 'install packed public packages', 600_000);

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
    access(join(installedStudio, 'examples', 'kanban-workdir', '.pinpawo', 'studio.json')),
    access(join(installedStudio, 'examples', 'kanban-workdir', 'wiki', 'PROJECT.md')),
  ]);

  const imported = await runProcess(process.execPath, [
    '--input-type=module',
    '--eval',
    "const studio = await import('@pinpawo/studio'); if (typeof studio.StudioHost !== 'function') throw new Error('StudioHost export missing');",
  ], consumerDir, 'import installed @pinpawo/studio', 30_000);
  assert.equal(imported.stderr, '');

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
      'initialize installed Studio kickstart',
      30_000,
    )
    : await runProcess(
      installedBin,
      ['init', '--workdir', initializedWorkdir],
      consumerDir,
      'initialize installed Studio kickstart',
      30_000,
    );
  assert.match(initialized.stdout, /Initialized Studio kickstart/);
  assert.equal(initialized.stderr, '');
  await Promise.all([
    access(join(initializedWorkdir, '.pinpawo', 'studio.json')),
    access(join(initializedWorkdir, '.pinpawo', 'pets', 'planner.json')),
    access(join(initializedWorkdir, 'wiki', 'PROJECT.md')),
  ]);

  const resolvedKickstart = await runProcess(process.execPath, [
    '--input-type=module',
    '--eval',
    [
      "const transport = await import('pinpawo/local-server-transport');",
      'transport.ensureLocalServerAuthToken();',
      "const studio = await import('@pinpawo/studio');",
      'const workdir = process.env.PINPAWO_SMOKE_WORKDIR;',
      "if (!workdir) throw new Error('missing smoke workdir');",
      'const configuration = await studio.resolveStudioHostConfig({',
      '  workdir,',
      '  resolvePlugin: studio.createInstalledStudioPluginResolver({ workdir }),',
      '});',
      'const names = configuration.plugins.map(({ name }) => name);',
      "const expected = ['http', 'kanban', 'scheduler', 'project-files', 'trigger'];",
      "if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`unexpected Plugins: ${JSON.stringify(names)}`);",
      "process.stdout.write(`${names.join(',')}\\n`);",
    ].join('\n'),
  ], consumerDir, 'resolve installed Studio kickstart Plugins', 30_000, {
    HOME: join(tempRoot, 'home'),
    USERPROFILE: join(tempRoot, 'home'),
    PINPAWO_SMOKE_WORKDIR: initializedWorkdir,
    PINPAWO_HELLO_TRIGGER_SECRET: 'install-smoke-trigger-secret-at-least-16-characters',
  });
  assert.equal(resolvedKickstart.stdout.trim(), 'http,kanban,scheduler,project-files,trigger');
  assert.equal(resolvedKickstart.stderr, '');
  process.stdout.write('[studio:install-smoke] installed library and CLI passed\n');
} finally {
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
  const payload = JSON.parse(result.stdout) as Array<{ filename?: unknown }>;
  assert.equal(typeof payload[0]?.filename, 'string');
  return join(destination, payload[0]!.filename as string);
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
  try {
    return await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    });
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
