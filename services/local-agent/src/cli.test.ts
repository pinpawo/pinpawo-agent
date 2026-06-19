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
  let received: unknown = null;
  const program = createLocalAgentCli({
    runAgent: (options) => {
      received = options;
    },
  });

  await program.parseAsync(['node', 'pinpawo-agent', 'run', '--workdir', '/tmp/pinpawo-workdir']);
  assert.deepEqual(received, {
    workdir: '/tmp/pinpawo-workdir',
    mode: 'chat',
  });
});

test('local agent CLI starts server in studio mode', async () => {
  let received: unknown = null;
  const program = createLocalAgentCli({
    runAgent: (options) => {
      received = options;
    },
  });

  await program.parseAsync([
    'node',
    'pinpawo-agent',
    'server',
    '--workdir',
    '/tmp/pinpawo-studio-server',
    '--mode',
    'studio',
  ]);

  assert.deepEqual(received, {
    workdir: '/tmp/pinpawo-studio-server',
    mode: 'studio',
  });
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

test('local agent CLI leaves studio migrate workdir undefined when omitted', async () => {
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
  ]);

  assert.deepEqual(received, {
    workdir: undefined,
    force: false,
  });
});
