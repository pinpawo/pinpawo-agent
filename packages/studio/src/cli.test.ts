import assert from 'node:assert/strict';
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
      return { workdir, files: ['.pinpawo/studio.json'] };
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
