import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalAgentCli } from './cli';

test('local agent CLI passes tui options to the handler', async () => {
  let received: { dryRun: boolean; workdir?: string } | null = null;
  const program = createLocalAgentCli({
    runTui: (options) => {
      received = options;
    },
  });

  await program.parseAsync(['node', 'pinpawo', 'tui', '--dry-run', '--workdir', '/tmp/pinpawo-tui-workdir']);

  assert.deepEqual(received, { dryRun: true, workdir: '/tmp/pinpawo-tui-workdir' });
});

test('local agent CLI launches OpenTUI v2 without invoking the legacy handler', async () => {
  let legacyCalls = 0;
  let received: { workdir?: string; check: boolean } | null = null;
  const program = createLocalAgentCli({
    runTui: () => {
      legacyCalls += 1;
    },
    runTuiV2: (options) => {
      received = options;
    },
  });

  await program.parseAsync([
    'node',
    'pinpawo',
    'tui',
    '--v2',
    '--workdir',
    '/tmp/pinpawo-tui-v2-workdir',
  ]);

  assert.equal(legacyCalls, 0);
  assert.deepEqual(received, {
    workdir: '/tmp/pinpawo-tui-v2-workdir',
    check: false,
  });
});

test('local agent CLI exposes a non-interactive OpenTUI v2 installation check', async () => {
  let received: { workdir?: string; check: boolean } | null = null;
  const handlers = {
    runTui: () => undefined,
    runTuiV2: (options: { workdir?: string; check: boolean }) => {
      received = options;
    },
  };

  await createLocalAgentCli(handlers).parseAsync([
    'node',
    'pinpawo',
    'tui',
    '--v2',
    '--check',
  ]);
  assert.deepEqual(received, {
    workdir: undefined,
    check: true,
  });

  await assert.rejects(
    createLocalAgentCli(handlers).parseAsync([
      'node',
      'pinpawo',
      'tui',
      '--check',
    ]),
    /--check requires.*--v2/,
  );
});

test('local agent CLI keeps an explicit legacy fallback during v2 dogfood', async () => {
  let legacyCalls = 0;
  let v2Calls = 0;
  const program = createLocalAgentCli({
    runTui: () => {
      legacyCalls += 1;
    },
    runTuiV2: () => {
      v2Calls += 1;
    },
  });

  await program.parseAsync(['node', 'pinpawo', 'tui', '--legacy']);

  assert.equal(legacyCalls, 1);
  assert.equal(v2Calls, 0);
});

test('local agent CLI rejects conflicting or legacy-only TUI flags', async () => {
  const handlers = {
    runTui: () => undefined,
    runTuiV2: () => undefined,
  };

  await assert.rejects(
    createLocalAgentCli(handlers).parseAsync([
      'node',
      'pinpawo',
      'tui',
      '--v2',
      '--legacy',
    ]),
    /Choose either --v2 or --legacy/,
  );
  await assert.rejects(
    createLocalAgentCli(handlers).parseAsync([
      'node',
      'pinpawo',
      'tui',
      '--v2',
      '--dry-run',
    ]),
    /--dry-run is only supported by the legacy Ink TUI/,
  );
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
    'pinpawo',
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

  await program.parseAsync(['node', 'pinpawo', 'setup', '--workdir', '/tmp/pinpawo-setup-workdir']);

  assert.deepEqual(received, {
    workdir: '/tmp/pinpawo-setup-workdir',
  });
});

test('local agent CLI applies run workdir option before handler', async () => {
  let received: { workdir?: string; stdio: boolean } | null = null;
  const program = createLocalAgentCli({
    runAgent: (options) => {
      received = options;
    },
  });

  await program.parseAsync(['node', 'pinpawo', 'run', '--workdir', '/tmp/pinpawo-workdir']);
  assert.deepEqual(received, {
    workdir: '/tmp/pinpawo-workdir',
    stdio: false,
  });
});

test('local agent CLI enables the single-peer JSONL stdio transport', async () => {
  let received: { workdir?: string; stdio: boolean } | null = null;
  const program = createLocalAgentCli({
    runAgent: (options) => {
      received = options;
    },
  });

  await program.parseAsync(['node', 'pinpawo', 'run', '--stdio']);
  assert.deepEqual(received, {
    workdir: undefined,
    stdio: true,
  });
});

test('local agent CLI passes Chrome extension registration options to the handler', async () => {
  let received: unknown = null;
  const program = createLocalAgentCli({
    runBrowser: (target, action, options) => {
      received = { target, action, options };
    },
  });

  await program.parseAsync([
    'node',
    'pinpawo',
    'browser',
    'extension',
    'register',
    '--extension-id',
    'abcdefghijklmnopabcdefghijklmnop',
  ]);

  assert.deepEqual(received, {
    target: 'extension',
    action: 'register',
    options: { extensionId: 'abcdefghijklmnopabcdefghijklmnop' },
  });
});
