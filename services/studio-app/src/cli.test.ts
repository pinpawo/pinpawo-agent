import assert from 'node:assert/strict';
import test from 'node:test';
import type { StudioHostApplicationOptions } from './studioHostApplication';
import { parseStudioHostCliArgs, runStudioHostCli } from './cli';

test('Studio application CLI routes explicit stdio options to the application', async () => {
  let received: StudioHostApplicationOptions | undefined;
  await runStudioHostCli([
    '--workdir',
    '/tmp/project',
    '--stdio',
  ], {
    runHost: (options) => { received = options; },
  });

  assert.deepEqual(received, {
    workdir: '/tmp/project',
    transport: { kind: 'stdio' },
  });
});

test('Studio Host CLI routes an explicit WebSocket port to the application', async () => {
  let received: StudioHostApplicationOptions | undefined;
  await runStudioHostCli(['--port', '4321'], {
    runHost: (options) => { received = options; },
  });

  assert.deepEqual(received, {
    transport: { kind: 'websocket', port: 4321 },
  });
});

test('Studio Host CLI requires exactly one transport', () => {
  assert.throws(
    () => parseStudioHostCliArgs([]),
    /Choose exactly one Studio transport/,
  );
  assert.throws(
    () => parseStudioHostCliArgs(['--stdio', '--port', '4321']),
    /Choose exactly one Studio transport/,
  );
});

test('Studio Host CLI validates ports and exposes help without starting a Host', async () => {
  assert.throws(
    () => parseStudioHostCliArgs(['--port', '70000']),
    /integer from 1 to 65535/,
  );
  let output = '';
  await runStudioHostCli(['--help'], {
    runHost: () => assert.fail('help must not start a Host'),
    writeOutput: (text) => { output += text; },
  });
  assert.match(output, /pinpawo-studio/);
  assert.match(output, /--stdio/);
  assert.match(output, /--port/);
});
