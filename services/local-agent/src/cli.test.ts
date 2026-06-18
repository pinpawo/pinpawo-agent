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
  let received: unknown = null;
  const program = createLocalAgentCli({
    runSetup: (options) => {
      received = options;
    },
  });

  await program.parseAsync(['node', 'pinpawo-agent', 'setup', '--workdir', '/tmp/pinpawo-setup-workdir']);

  assert.deepEqual(received, {
    workdir: '/tmp/pinpawo-setup-workdir',
  });
});

test('local agent CLI applies run workdir option before handler', async () => {
  const previous = process.env.PINPAWO_WORKDIR;
  let received: string | undefined;
  const program = createLocalAgentCli({
    runAgent: () => {
      received = process.env.PINPAWO_WORKDIR;
    },
  });

  try {
    await program.parseAsync(['node', 'pinpawo-agent', 'run', '--workdir', '/tmp/pinpawo-workdir']);
    assert.equal(received, '/tmp/pinpawo-workdir');
  } finally {
    if (previous === undefined) {
      delete process.env.PINPAWO_WORKDIR;
    } else {
      process.env.PINPAWO_WORKDIR = previous;
    }
  }
});

test('local agent CLI passes studio migrate options to the handler', async () => {
  let received: unknown = null;
  const program = createLocalAgentCli({
    runStudioMigrate: (options) => {
      received = options;
    },
  });

  await program.parseAsync([
    'node',
    'pinpawo-agent',
    'studio',
    'migrate',
    '--workdir',
    '/tmp/pinpawo-studio-workdir',
    '--force',
  ]);

  assert.deepEqual(received, {
    workdir: '/tmp/pinpawo-studio-workdir',
    force: true,
  });
});
