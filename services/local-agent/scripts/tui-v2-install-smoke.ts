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

const scriptDir = dirname(fileURLToPath(import.meta.url));
const localAgentRoot = resolve(scriptDir, '..');
const workspaceRoot = resolve(localAgentRoot, '..', '..');
const petAgentRoot = resolve(workspaceRoot, 'packages', 'pet-agent');
const tuiRoot = resolve(workspaceRoot, 'services', 'tui');
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error('Run this smoke through npm so npm_execpath is available.');
}

const tempRoot = await mkdtemp(join(tmpdir(), 'pinpawo-tui-install-smoke-'));
const artifactDir = join(tempRoot, 'artifacts');
const consumerDir = join(tempRoot, 'consumer');
const configuredCacheDir =
  process.env.PINPAWO_TUI_INSTALL_NPM_CACHE?.trim();
const cacheDir = configuredCacheDir
  ? resolve(configuredCacheDir)
  : process.env.CI
    ? undefined
    : join(
        workspaceRoot,
        'node_modules',
        '.cache',
        'pinpawo-tui-install-smoke-npm',
      );
const [{ version: localAgentVersion }, { version: tuiVersion }] =
  await Promise.all([
    readPackageVersion(localAgentRoot),
    readPackageVersion(tuiRoot),
  ]);

try {
  const directories = [
    mkdir(artifactDir, { recursive: true }),
    mkdir(consumerDir, { recursive: true }),
  ];
  if (cacheDir) {
    directories.push(mkdir(cacheDir, { recursive: true }));
  }
  await Promise.all(directories);
  await writeFile(join(consumerDir, 'package.json'), `${JSON.stringify({
    name: 'pinpawo-tui-install-smoke',
    private: true,
    version: '0.0.0',
  }, null, 2)}\n`);

  const [petAgentTarball, localAgentTarball] = await Promise.all([
    packWorkspacePackage(petAgentRoot, artifactDir),
    packWorkspacePackage(localAgentRoot, artifactDir),
  ]);
  await runNpm([
    'install',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--prefer-offline',
    '--save=false',
    petAgentTarball,
    localAgentTarball,
  ], consumerDir, 'install tarballs in an empty project', 600_000);

  const installedRoot = join(consumerDir, 'node_modules', 'pinpawo');
  const installedPackage = JSON.parse(
    await readFile(join(installedRoot, 'package.json'), 'utf8'),
  ) as {
    version?: unknown;
  };
  assert.equal(installedPackage.version, localAgentVersion);
  await Promise.all([
    assertReadable(join(installedRoot, 'dist', 'index.js')),
    assertReadable(join(installedRoot, 'dist', 'tui', 'main.js')),
    assertReadable(join(installedRoot, 'dist', 'tui', 'manifest.json')),
    assertReadable(join(consumerDir, 'node_modules', '@opentui', 'core')),
    assertReadable(installedBunPath(consumerDir)),
  ]);

  const probe = await runProcess(process.execPath, [
    join(installedRoot, 'dist', 'index.js'),
    'tui',
    '--v2',
    '--check',
  ], consumerDir, {
    label: 'run the installed v2 launcher check',
    timeoutMs: 30_000,
  });
  assert.equal(probe.stderr, '');
  assert.equal(probe.stdout, `PinPawo TUI v2 ${tuiVersion}\n`);
  process.stdout.write(
    `[tui:install-smoke] ${process.platform}-${process.arch} ${probe.stdout}`,
  );
  if (process.platform === 'darwin') {
    await runInstalledQaPty(
      join(installedRoot, 'dist', 'index.js'),
      consumerDir,
    );
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function runInstalledQaPty(
  installedEntry: string,
  cwd: string,
) {
  const expectScript = [
    'set timeout 20',
    'set stty_init "rows 28 columns 96"',
    [
      'spawn -noecho',
      JSON.stringify(process.execPath),
      JSON.stringify(installedEntry),
      'tui',
      '--v2',
      '--qa',
    ].join(' '),
    'fconfigure $spawn_id -translation binary -encoding binary',
    'expect {',
    '  -exact "PinPawo QA" {}',
    '  timeout { exit 181 }',
    '  eof { exit 182 }',
    '}',
    'expect {',
    '  -exact "Enter to send" {}',
    '  timeout { exit 183 }',
    '  eof { exit 184 }',
    '}',
    'send_error "qa-stage: ready\\n"',
    'send -- "Installed QA"',
    'expect {',
    '  -exact "Installed QA" {}',
    '  timeout { exit 185 }',
    '  eof { exit 186 }',
    '}',
    'send_error "qa-stage: draft\\n"',
    'send -- "\\r"',
    'expect {',
    '  -exact "PinPawo QA is thinking" {}',
    '  timeout { exit 187 }',
    '  eof { exit 188 }',
    '}',
    'send_error "qa-stage: thinking\\n"',
    // OpenTUI repaints an existing placeholder as terminal cell diffs. The
    // resulting PTY bytes do not necessarily contain the final placeholder as
    // one contiguous string, so use the completed run's usage as the stable
    // install-level completion signal instead.
    'expect {',
    '  -exact "20,000/3,000" {}',
    '  timeout { exit 189 }',
    '  eof { exit 190 }',
    '}',
    'send_error "qa-stage: completed\\n"',
    'after 250',
    'send -- "/quit"',
    'expect {',
    '  -exact "/quit" {}',
    '  timeout { exit 191 }',
    '  eof { exit 192 }',
    '}',
    'send_error "qa-stage: quit-draft\\n"',
    'after 100',
    'send -- "\\r"',
    'expect {',
    '  eof {}',
    '  timeout { exit 193 }',
    '}',
    'send_error "qa-stage: quit\\n"',
    'set result [wait]',
    'exit [lindex $result 3]',
  ].join('\n');
  await runProcess('/usr/bin/expect', ['-c', expectScript], cwd, {
    env: {
      TERM: 'xterm-256color',
    },
    label: 'run the installed v2 QA flow in a PTY',
    timeoutMs: 35_000,
  });
}

async function packWorkspacePackage(packageRoot: string, destination: string) {
  const result = await runNpm([
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    destination,
  ], packageRoot, `pack ${packageRoot}`, 60_000);
  const payload = JSON.parse(result.stdout) as Array<{
    filename?: unknown;
  }>;
  const filename = payload[0]?.filename;
  assert.equal(typeof filename, 'string');
  return join(destination, filename as string);
}

async function runNpm(
  args: string[],
  cwd: string,
  label: string,
  timeoutMs: number,
) {
  return runProcess(process.execPath, [npmCli!, ...args], cwd, {
    env: cacheDir ? { npm_config_cache: cacheDir } : undefined,
    label,
    timeoutMs,
  });
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  options: {
    env?: NodeJS.ProcessEnv;
    label: string;
    timeoutMs: number;
  },
) {
  const startedAt = Date.now();
  process.stdout.write(`[tui:install-smoke] ${options.label}...\n`);
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...options.env,
      },
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs,
    });
    process.stdout.write(
      `[tui:install-smoke] ${options.label} passed (${Date.now() - startedAt}ms)\n`,
    );
    return result;
  } catch (error) {
    const failure = error as Error & {
      code?: number | string;
      signal?: NodeJS.Signals;
      stdout?: string;
      stderr?: string;
    };
    assert.fail([
      `${options.label} failed after ${Date.now() - startedAt}ms.`,
      `${command} ${args.join(' ')}`,
      `code=${String(failure.code)} signal=${String(failure.signal)}`,
      failure.stderr || failure.stdout || failure.message,
    ].join('\n'));
  }
}

async function assertReadable(path: string) {
  await access(path);
}

function installedBunPath(consumerRoot: string) {
  return process.platform === 'win32'
    ? join(consumerRoot, 'node_modules', 'bun', 'bin', 'bun.exe')
    : join(consumerRoot, 'node_modules', '.bin', 'bun');
}

async function readPackageVersion(packageRoot: string) {
  const parsed = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  ) as {
    version?: unknown;
  };
  assert.equal(typeof parsed.version, 'string');
  return { version: parsed.version as string };
}
