import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalAgentCli } from './cli';

test('local agent CLI passes tui options to the handler', async () => {
  let received: { dryRun: boolean } | null = null;
  const program = createLocalAgentCli({
    runTui: (options) => {
      received = options;
    },
  });

  await program.parseAsync(['node', 'pinpawo-agent', 'tui', '--dry-run']);

  assert.deepEqual(received, { dryRun: true });
});

test('local agent CLI passes init options to the handler', async () => {
  let received: unknown = null;
  const program = createLocalAgentCli({
    runInit: (options) => {
      received = options;
    },
  });

  await program.parseAsync([
    'node',
    'pinpawo-agent',
    'init',
    '--dir',
    '/tmp/pinpawo-test',
    '--force',
    '--no-example-capability',
  ]);

  assert.deepEqual(received, {
    dir: '/tmp/pinpawo-test',
    force: true,
    exampleCapability: false,
  });
});

test('local agent CLI runs setup guide handler', async () => {
  let called = false;
  const program = createLocalAgentCli({
    runSetup: () => {
      called = true;
    },
  });

  await program.parseAsync(['setup'], { from: 'user' });

  assert.equal(called, true);
});
