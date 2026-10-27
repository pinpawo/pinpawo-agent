import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import type { StudioHostProcessOptions } from './studioHostProcess';
import { parseStudioHostCliArgs, runStudioHostCli } from './cli';

test('Studio CLI starts without a Studio-owned control-plane transport', async () => {
  let received: StudioHostProcessOptions | undefined;
  await runStudioHostCli([
    '--workdir',
    '/tmp/project',
  ], {
    runHost: (options) => { received = options; },
  });

  assert.deepEqual(received, {
    workdir: '/tmp/project',
  });
});

test('Studio CLI forwards an optional resident Pet listener port', async () => {
  let received: StudioHostProcessOptions | undefined;
  await runStudioHostCli(['--pet-port', '4321'], {
    runHost: (options) => { received = options; },
  });

  assert.deepEqual(received, {
    agentSessionPort: 4321,
  });
});

test('Studio Host CLI defaults to an available Agent Session port', () => {
  assert.deepEqual(parseStudioHostCliArgs([]), {
    help: false,
    command: 'start',
    options: {},
  });
});

test('Studio CLI parses tmux layout and Console commands separately from the Host', () => {
  assert.deepEqual(parseStudioHostCliArgs([
    'tmux',
    '--pet-port',
    '4321',
    '--pet',
    'planner',
    '--pet',
    'reviewer',
    '--studio-url',
    'http://127.0.0.1:3212',
    '--session',
    'demo',
    '--detached',
    '--reset',
    '--console',
    '--url',
    'http://127.0.0.1:5176',
  ]), {
    help: false,
    command: 'tmux',
    options: {
      agentSessionPort: 4321,
      petIds: ['planner', 'reviewer'],
      studioUrl: 'http://127.0.0.1:3212',
      sessionName: 'demo',
      detached: true,
      reset: true,
      openConsole: true,
      consoleUrl: 'http://127.0.0.1:5176',
    },
  });
  assert.deepEqual(parseStudioHostCliArgs(['console', '--url', 'http://localhost:5173']), {
    help: false,
    command: 'console',
    options: { url: 'http://localhost:5173' },
  });
});

test('Studio CLI delegates tmux and Console commands without starting the Host', async () => {
  let tmuxPort: number | undefined;
  let consoleUrl: string | undefined;
  await runStudioHostCli(['tmux', '--pet-port', '4321', '--detached'], {
    runHost: () => assert.fail('tmux must not start the Host in this process'),
    launchTmux: ({ agentSessionPort }) => { tmuxPort = agentSessionPort; },
  });
  await runStudioHostCli(['console'], {
    runHost: () => assert.fail('console must not start the Host'),
    openConsole: ({ url }) => { consoleUrl = url; },
  });
  assert.equal(tmuxPort, 4321);
  assert.equal(consoleUrl, undefined);
});

test('Studio CLI initializes a workdir without starting a Host', async () => {
  let received: string | undefined;
  let output = '';
  await runStudioHostCli(['init', '--workdir', '/tmp/new-studio'], {
    runHost: () => assert.fail('init must not start a Host'),
    initWorkdir: async ({ workdir }) => {
      received = workdir;
      return { workdir, files: ['.pinpawo/studio.json'], wikiDirectory: '/tmp/studio-data/wiki' };
    },
    writeOutput: (text) => { output += text; },
  });

  assert.equal(received, '/tmp/new-studio');
  assert.match(output, /Initialized Studio workdir/);
  assert.throws(
    () => parseStudioHostCliArgs(['init', '--pet-port', '3210']),
    /not valid for Studio init/,
  );
  assert.throws(
    () => parseStudioHostCliArgs(['tmux']),
    /--pet-port is required/,
  );
  assert.throws(
    () => parseStudioHostCliArgs(['tmux', '--pet-port', '3210', '--workdir', '/tmp/project']),
    /not valid for Studio tmux/,
  );
});

test('Studio CLI accepts an init-only Studio data root', () => {
  assert.deepEqual(parseStudioHostCliArgs(['init', '--workdir', '/tmp/project', '--studio-data-root', '/tmp/studio-data']), {
    help: false, command: 'init', options: { workdir: '/tmp/project', studioDataRoot: '/tmp/studio-data' },
  });
  for (const args of [
    ['start', '--studio-data-root', '/tmp/studio-data'],
    ['tmux', '--studio-data-root', '/tmp/studio-data'],
    ['console', '--studio-data-root', '/tmp/studio-data'],
  ]) assert.throws(() => parseStudioHostCliArgs(args), /only valid for Studio init/);
  assert.throws(() => parseStudioHostCliArgs(['init', '--studio-data-root']), /requires a value/);
});

test('Studio CLI initializes an isolated HOME workdir with an explicit external data root', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-cli-home-'));
  const home = path.join(parent, 'home');
  const dataRoot = path.join(parent, 'studio-data');
  await mkdir(home);
  t.after(async () => { await rm(parent, { recursive: true, force: true }); });
  const cliUrl = new URL('./cli.ts', import.meta.url).href;
  const program = `import { runStudioHostCli } from ${JSON.stringify(cliUrl)}; await runStudioHostCli(['init', '--workdir', process.env.TEST_STUDIO_HOME, '--studio-data-root', process.env.TEST_STUDIO_DATA_ROOT]);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', program], {
    env: { ...process.env, HOME: home, USERPROFILE: home, TEST_STUDIO_HOME: home, TEST_STUDIO_DATA_ROOT: dataRoot },
  });
  const config = JSON.parse(await readFile(path.join(home, '.pinpawo', 'studio.json'), 'utf8')) as {
    plugins: Array<{ id: string; options?: { wikiDirectory?: string } }>;
  };
  const wikiDirectory = config.plugins.find(({ id }) => id === '@pinpawo-plugin/project-files')?.options?.wikiDirectory;
  assert.ok(wikiDirectory);
  assert.equal(path.dirname(path.dirname(wikiDirectory)), dataRoot);
  assert.match(await readFile(path.join(wikiDirectory, 'PROJECT.md'), 'utf8'), /Project Overview/);
  assert.match(stdout, /Initialized Studio workdir/);
  await assert.rejects(readFile(path.join(home, 'wiki', 'PROJECT.md')), /ENOENT/);
});

test('Studio CLI initializes a non-Git HOME with its default Studio data root', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-cli-home-default-'));
  const home = path.join(parent, 'home');
  await mkdir(home);
  t.after(async () => { await rm(parent, { recursive: true, force: true }); });
  const cliUrl = new URL('./cli.ts', import.meta.url).href;
  const program = `import { runStudioHostCli } from ${JSON.stringify(cliUrl)}; await runStudioHostCli(['init', '--workdir', process.env.TEST_STUDIO_HOME]);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', program], {
    env: { ...process.env, HOME: home, USERPROFILE: home, TEST_STUDIO_HOME: home },
  });
  const config = JSON.parse(await readFile(path.join(home, '.pinpawo', 'studio.json'), 'utf8')) as {
    plugins: Array<{ id: string; options?: { wikiDirectory?: string } }>;
  };
  const wikiDirectory = config.plugins.find(({ id }) => id === '@pinpawo-plugin/project-files')?.options?.wikiDirectory;
  assert.ok(wikiDirectory);
  assert.equal(path.dirname(path.dirname(wikiDirectory)), path.join(home, '.pinpawo', 'studios'));
  assert.match(await readFile(path.join(wikiDirectory, 'PROJECT.md'), 'utf8'), /Project Overview/);
  assert.match(stdout, /Initialized Studio workdir/);
  await assert.rejects(readFile(path.join(home, 'wiki', 'PROJECT.md')), /ENOENT/);
});

test('Studio CLI rejects default data in a Git-contained HOME and accepts an external root', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-cli-home-git-'));
  const repo = path.join(parent, 'repo');
  const home = path.join(repo, 'home');
  const dataRoot = path.join(parent, 'studio-data');
  await mkdir(home, { recursive: true });
  // A .git file also denotes a linked Git worktree; no real repository is needed.
  await writeFile(path.join(repo, '.git'), 'gitdir: fixture\n');
  t.after(async () => { await rm(parent, { recursive: true, force: true }); });
  const cliUrl = new URL('./cli.ts', import.meta.url).href;
  const program = `import { runStudioHostCli } from ${JSON.stringify(cliUrl)}; await runStudioHostCli(['init', '--workdir', process.env.TEST_STUDIO_HOME, ...JSON.parse(process.env.TEST_STUDIO_ARGS)]);`;
  const run = (args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', program], {
    env: { ...process.env, HOME: home, USERPROFILE: home, TEST_STUDIO_HOME: home, TEST_STUDIO_ARGS: JSON.stringify(args) },
  });
  await assert.rejects(run([]), /Studio data directory must be outside the project workdir/);
  await assert.rejects(readFile(path.join(home, '.pinpawo', 'studio.json')), /ENOENT/);
  await run(['--studio-data-root', dataRoot]);
  const config = JSON.parse(await readFile(path.join(home, '.pinpawo', 'studio.json'), 'utf8')) as {
    plugins: Array<{ id: string; options?: { wikiDirectory?: string } }>;
  };
  const wikiDirectory = config.plugins.find(({ id }) => id === '@pinpawo-plugin/project-files')?.options?.wikiDirectory;
  assert.ok(wikiDirectory);
  assert.equal(path.dirname(path.dirname(wikiDirectory)), dataRoot);
  assert.match(await readFile(path.join(wikiDirectory, 'PROJECT.md'), 'utf8'), /Project Overview/);
});

test('Studio CLI rejects an internal data root for a non-HOME project', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-cli-project-'));
  const home = path.join(parent, 'home');
  const project = path.join(parent, 'project');
  await mkdir(home);
  await mkdir(project);
  t.after(async () => { await rm(parent, { recursive: true, force: true }); });
  const cliUrl = new URL('./cli.ts', import.meta.url).href;
  const program = `import { runStudioHostCli } from ${JSON.stringify(cliUrl)}; await runStudioHostCli(['init', '--workdir', process.env.TEST_STUDIO_PROJECT, '--studio-data-root', process.env.TEST_STUDIO_DATA_ROOT]);`;
  await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', program], {
    env: { ...process.env, HOME: home, USERPROFILE: home, TEST_STUDIO_PROJECT: project, TEST_STUDIO_DATA_ROOT: path.join(project, 'data') },
  }), /Studio data directory must be outside the project workdir/);
  await assert.rejects(readFile(path.join(project, '.pinpawo', 'studio.json')), /ENOENT/);
});

test('Studio Host CLI validates ports and exposes help without starting a Host', async () => {
  assert.throws(
    () => parseStudioHostCliArgs(['--pet-port', '70000']),
    /integer from 1 to 65535/,
  );
  let output = '';
  await runStudioHostCli(['--help'], {
    runHost: () => assert.fail('help must not start a Host'),
    writeOutput: (text) => { output += text; },
  });
  assert.match(output, /pinpawo-studio/);
  assert.match(output, /--pet-port/);
  assert.doesNotMatch(output, /--stdio/);
});
