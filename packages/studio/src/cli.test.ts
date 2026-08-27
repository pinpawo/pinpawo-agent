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
    options: {},
  });
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
