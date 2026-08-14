import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalAgentCli } from './cli';

test('tui launches the v2 client by default', async () => {
  // legacy Ink TUI 已删除,`pinpawo tui` 不再需要 --v2 opt-in。
  let received: { workdir?: string; check: boolean; qa: boolean } | null = null;
  const program = createLocalAgentCli({
    runTuiV2: (options) => { received = options; },
  });

  await program.parseAsync([
    'node', 'pinpawo', 'tui', '--workdir', '/tmp/pinpawo-tui-workdir',
  ]);

  assert.deepEqual(received, {
    workdir: '/tmp/pinpawo-tui-workdir',
    check: false,
    qa: false,
  });
});

test('the removed legacy flags are no longer declared', () => {
  // --v2 / --legacy / --dry-run 随 legacy 客户端一起退役。留着会让用户以为
  // 还有第二个客户端可选。
  //
  // 这里断言"选项没被声明"而不是"解析会失败":Commander 未配 exitOverride,
  // 未知选项会直接 process.exit,断言捕获不到。
  const tui = createLocalAgentCli({ runTuiV2: () => undefined })
    .commands.find((command) => command.name() === 'tui');
  assert.ok(tui, 'the tui command must exist');

  const flags = tui.options.map((option) => option.long);
  assert.deepEqual(flags.sort(), ['--check', '--qa', '--workdir']);
});

test('tui still rejects --check together with --qa', async () => {
  await assert.rejects(
    createLocalAgentCli({ runTuiV2: () => undefined })
      .parseAsync(['node', 'pinpawo', 'tui', '--check', '--qa']),
    /Choose either --check or --qa/,
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

test('local agent CLI applies server workdir option before handler', async () => {
  let received: { workdir?: string; stdio: boolean; mode?: string } | null = null;
  const program = createLocalAgentCli({
    runAgent: (options) => {
      received = options;
    },
  });

  await program.parseAsync(['node', 'pinpawo', 'server', '--workdir', '/tmp/pinpawo-workdir']);
  assert.deepEqual(received, {
    workdir: '/tmp/pinpawo-workdir',
    stdio: false,
    mode: 'chat',
  });
});

test('local agent CLI enables the single-peer JSONL stdio transport', async () => {
  let received: { workdir?: string; stdio: boolean; mode?: string } | null = null;
  const program = createLocalAgentCli({
    runAgent: (options) => {
      received = options;
    },
  });

  await program.parseAsync(['node', 'pinpawo', 'server', '--stdio']);
  assert.deepEqual(received, {
    workdir: undefined,
    stdio: true,
    mode: 'chat',
  });
});

test('local agent CLI defaults the server command to chat mode', async () => {
  let received: { mode?: string } | null = null;
  const program = createLocalAgentCli({
    runAgent: (options) => {
      received = options;
    },
  });

  await program.parseAsync(['node', 'pinpawo', 'server']);
  assert.equal(received!.mode, 'chat');
});

test('local agent CLI passes studio mode through to the handler', async () => {
  let received: { mode?: string } | null = null;
  const program = createLocalAgentCli({
    runAgent: (options) => {
      received = options;
    },
  });

  await program.parseAsync(['node', 'pinpawo', 'server', '--mode', 'studio']);
  assert.equal(received!.mode, 'studio');
});

test('local agent CLI keeps run as a chat-mode alias of server', async () => {
  // `run` predates server mode and starts chat, so existing scripts and
  // service units must keep working unchanged (#561).
  let received: { workdir?: string; stdio: boolean; mode?: string } | null = null;
  const program = createLocalAgentCli({
    runAgent: (options) => {
      received = options;
    },
  });

  await program.parseAsync(['node', 'pinpawo', 'run']);
  assert.deepEqual(received, {
    workdir: undefined,
    stdio: false,
    mode: 'chat',
  });
});

test('local agent CLI routes run and server through the same handler options', async () => {
  // One shared definition, so the two names cannot drift into separate
  // runtime paths.
  const seen: unknown[] = [];
  const program = createLocalAgentCli({
    runAgent: (options) => {
      seen.push(options);
    },
  });

  await program.parseAsync(['node', 'pinpawo', 'run', '--mode', 'studio', '--stdio']);
  await program.parseAsync(['node', 'pinpawo', 'server', '--mode', 'studio', '--stdio']);

  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], seen[1]);
});

test('local agent CLI rejects an unknown server mode instead of falling back', async () => {
  let called = false;
  const program = createLocalAgentCli({
    runAgent: () => {
      called = true;
    },
  });

  await assert.rejects(
    () => program.parseAsync(['node', 'pinpawo', 'server', '--mode', 'kitchen-sink']),
    /Expected one of: chat, studio/,
  );
  assert.equal(called, false);
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
