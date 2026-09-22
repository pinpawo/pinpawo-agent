import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { createShellEnvironment } from './shellEnvironment';
import { createLocalRuntimeFixture, testExecution } from './shellTestSupport';
import type { ShellResult } from './shellClient';

const posix = process.platform !== 'win32';
const scope = { execution: testExecution() };
const command = (value: string, cwd = process.cwd(), timeoutMs = 30_000) => ({
  command: value, cwd, timeoutMs, maxOutputChars: 4096,
});
const argv = (args: string[], cwd = process.cwd()) => ({
  program: process.execPath, args, cwd, timeoutMs: 30_000, maxOutputChars: 4096,
});
const started = (result: ShellResult) => {
  assert.equal(result.status, 'yielded');
  if (result.status !== 'yielded') throw new Error('Expected a running process.');
  return result.processId;
};

test('shared environment isolates clients and Toolkit process ownership', { skip: !posix }, async (t) => {
  const fixture = createLocalRuntimeFixture();
  t.after(() => fixture.close());
  const a = fixture.client('bash', 'a');
  const b = fixture.client('bash', 'b');
  const git = fixture.client('git', 'a');
  const first = started(await a.run(command('sleep 10', process.cwd(), 30), scope));
  const second = started(await b.run(command('sleep 10', process.cwd(), 30), scope));
  await assert.rejects(b.wait({ processId: first, timeoutMs: 0 }, scope), /different execution/);
  await assert.rejects(git.terminate(first, scope), /different execution/);
  await fixture.environment.releaseClient('a');
  assert.equal((await b.list(scope))[0]?.processId, second);
  assert.equal((await b.list(scope))[0]?.status, 'running');
  await assert.rejects(a.list(scope), /closed/);
  assert.equal((await b.terminate(second, scope)).status, 'terminated');
});

test('different instances keep separate resources even with identical configuration', { skip: !posix }, async (t) => {
  const first = createLocalRuntimeFixture();
  const second = createLocalRuntimeFixture();
  t.after(async () => { await Promise.all([first.close(), second.close()]); });
  const processId = started(await first.client().run(command('sleep 10', process.cwd(), 30), scope));
  await assert.rejects(second.client().wait({ processId, timeoutMs: 0 }, scope), /No such process/);
  await first.close();
  assert.equal((await second.client().run(command('printf alive'), scope)).stdout, 'alive');
});

test('yield detaches the original signal and keeps output available to its owner', { skip: !posix }, async (t) => {
  const fixture = createLocalRuntimeFixture();
  t.after(() => fixture.close());
  const abort = new AbortController();
  const client = fixture.client();
  const processId = started(await client.run(command('printf first; sleep 0.2; printf second', process.cwd(), 40), {
    ...scope, signal: abort.signal,
  }));
  abort.abort();
  const result = await client.wait({ processId, timeoutMs: 2000 }, scope);
  assert.equal(result.process.status, 'exited');
  assert.equal(result.stdout, 'second');
  assert.equal((await client.wait({ processId, timeoutMs: 0 }, scope)).stdout, '');
});

test('disconnect cancels in-flight creation and cannot leave a process behind', { skip: !posix }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-disconnect-'));
  const fixture = createLocalRuntimeFixture();
  t.after(async () => { await fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  const marker = join(dir, 'late');
  const run = fixture.client().run(command(`sleep 0.4; printf leaked > '${marker}'`), scope);
  await fixture.environment.releaseClient('test-client');
  assert.equal((await run).status, 'aborted');
  await new Promise((resolveDone) => setTimeout(resolveDone, 500));
  assert.equal(existsSync(marker), false);
});

test('cancelling a wait does not terminate the yielded process', { skip: !posix }, async (t) => {
  const fixture = createLocalRuntimeFixture();
  t.after(() => fixture.close());
  const client = fixture.client();
  const processId = started(await client.run(command('sleep 10', process.cwd(), 20), scope));
  const abort = new AbortController();
  const wait = client.wait({ processId, timeoutMs: 10_000 }, { ...scope, signal: abort.signal });
  abort.abort();
  await assert.rejects(wait, { name: 'AbortError' });
  assert.equal((await client.list(scope))[0]?.status, 'running');
});

test('argv execution preserves quoting and per-call env does not mutate a shared environment', async (t) => {
  const fixture = createLocalRuntimeFixture({ type: 'shell', env: { PINPAWO_TEST_ENV: 'base' } });
  t.after(() => fixture.close());
  const args = ['space value', '中文', '$(echo not-run)', '"quotes"'];
  const result = await fixture.client('git').exec({
    ...argv(['-e', 'console.log(JSON.stringify({args:process.argv.slice(1),value:process.env.PINPAWO_TEST_ENV}))', ...args]),
    env: { PINPAWO_TEST_ENV: 'one-call', LC_ALL: 'C' },
  }, scope);
  assert.deepEqual(JSON.parse(result.stdout), { args, value: 'one-call' });
  const next = await fixture.client('bash').exec(argv(['-e', 'console.log(process.env.PINPAWO_TEST_ENV)']), scope);
  assert.equal(next.stdout.trim(), 'base');
});

test('one instance freezes its environment while a different instance can select a different one', async (t) => {
  const previous = process.env.PINPAWO_TEST_SNAPSHOT;
  process.env.PINPAWO_TEST_SNAPSHOT = 'initial';
  const first = createLocalRuntimeFixture();
  process.env.PINPAWO_TEST_SNAPSHOT = 'changed';
  const second = createLocalRuntimeFixture();
  if (previous === undefined) delete process.env.PINPAWO_TEST_SNAPSHOT;
  else process.env.PINPAWO_TEST_SNAPSHOT = previous;
  t.after(async () => { await first.close(); await second.close(); });
  const options = argv(['-e', 'console.log(process.env.PINPAWO_TEST_SNAPSHOT)']);
  assert.equal((await first.client().exec(options, scope)).stdout.trim(), 'initial');
  assert.equal((await second.client().exec(options, scope)).stdout.trim(), 'changed');
});

test('minimal argv environment removes secrets and preserves explicit locale policy', async (t) => {
  const fixture = createLocalRuntimeFixture({ type: 'shell', env: { TEST_PRIVATE_VALUE: 'private' } });
  t.after(() => fixture.close());
  const result = await fixture.client().exec({
    ...argv(['-e', 'console.log(JSON.stringify(process.env))']),
    envMode: 'minimal', env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  }, scope);
  const env = JSON.parse(result.stdout);
  assert.equal(env.TEST_PRIVATE_VALUE, undefined);
  assert.equal(env.LANG, 'C.UTF-8');
  assert.ok(env.PATH);
});

test('an empty environment uses platform defaults without inheriting Host variables', async (t) => {
  const previous = process.env.PINPAWO_TEST_EMPTY_ENV;
  let fixture: ReturnType<typeof createLocalRuntimeFixture>;
  process.env.PINPAWO_TEST_EMPTY_ENV = 'must-not-inherit';
  try { fixture = createLocalRuntimeFixture({ type: 'shell', env: {} }); }
  finally {
    if (previous === undefined) delete process.env.PINPAWO_TEST_EMPTY_ENV;
    else process.env.PINPAWO_TEST_EMPTY_ENV = previous;
  }
  t.after(() => fixture.close());
  const result = await fixture.client().exec(argv([
    '-e', 'console.log(JSON.stringify({inherited:process.env.PINPAWO_TEST_EMPTY_ENV??null,path:process.env.PATH}))',
  ]), scope);
  const env = JSON.parse(result.stdout);
  assert.equal(env.inherited, null);
  assert.ok(env.path);
});

test('configured programs win over PATH for both shell names and argv tools', { skip: !posix }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-program-map-'));
  const selectedGit = join(dir, 'selected-git');
  writeFileSync(selectedGit, '#!/bin/bash\nprintf selected');
  chmodSync(selectedGit, 0o755);
  const competing = join(dir, 'git');
  writeFileSync(competing, '#!/bin/bash\nprintf wrong');
  chmodSync(competing, 0o755);
  const fixture = createLocalRuntimeFixture({
    type: 'shell', programs: { git: selectedGit }, env: { PATH: `${dir}:${process.env.PATH}` },
  });
  t.after(async () => { await fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await fixture.client('bash').run(command('git'), scope)).stdout, 'selected');
  assert.equal((await fixture.client('git').exec({
    program: 'git', args: [], cwd: dir, timeoutMs: 1000, maxOutputChars: 100,
  }, scope)).stdout, 'selected');
});

test('POSIX program launchers preserve wrapper paths and argv for shell and direct execution', { skip: !posix }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "shell wrapper 中文 ' "));
  const wrapper = join(dir, 'git');
  const helper = join(dir, 'helper');
  writeFileSync(wrapper, '#!/bin/sh\nexec "$(dirname "$0")/helper" "$@"\n');
  writeFileSync(helper, '#!/bin/sh\nprintf "%s\\n" "$0" "$@"\n');
  chmodSync(wrapper, 0o755); chmodSync(helper, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const args = ['space value', '中文', "single ' quote", 'double " quote', '$(touch not-run)', ''];
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const config of [
    { type: 'shell', programs: { git: wrapper } },
    { type: 'shell', env: { PATH: `${dir}${delimiter}${process.env.PATH}` } },
  ]) {
    const fixture = createLocalRuntimeFixture(config);
    try {
      const direct = await fixture.client('git').exec({
        program: 'git', args, cwd: dir, timeoutMs: 30_000, maxOutputChars: 4096,
      }, scope);
      const shell = await fixture.client().run(command(`git ${args.map(quote).join(' ')}`, dir), scope);
      assert.equal(shell.status, 'exited');
      if (shell.status === 'exited') assert.equal(shell.code, 0);
      assert.equal(direct.stdout, [helper, ...args, ''].join('\n'));
      assert.equal(shell.stdout, direct.stdout);
      assert.equal(shell.stderr, '');
      assert.equal(existsSync(join(dir, 'not-run')), false);
    } finally { await fixture.close(); }
  }
});

test('yielded descendant cleanup remains running until wait, disconnect, or close confirms it', { skip: !posix }, async () => {
  for (const operation of ['wait', 'disconnect', 'close'] as const) {
    const fixture = createLocalRuntimeFixture();
    let pid: number | undefined;
    try {
      const client = fixture.client();
      const result = await client.run(command('trap "" TERM; sleep 30 >/dev/null 2>&1 & echo $!', process.cwd(), 1000), scope);
      const processId = started(result);
      pid = Number(result.stdout.trim());
      assert.ok(Number.isInteger(pid) && pid > 0);
      process.kill(pid, 0);
      assert.equal((await client.list(scope))[0]?.status, 'running');
      assert.equal((await client.wait({ processId, timeoutMs: 0 }, scope)).process.status, 'running');
      if (operation === 'wait') {
        const completed = await client.wait({ processId, timeoutMs: 5000 }, scope);
        assert.equal(completed.process.status, 'exited');
        assert.equal(completed.process.exitCode, 0);
      } else if (operation === 'disconnect') {
        await fixture.environment.releaseClient('test-client');
      } else {
        await fixture.close();
      }
      assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
    } finally {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      await fixture.close();
    }
  }
});

test('bundled ripgrep ignores a competing PATH program and keeps search limits', { skip: !posix }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-rg-'));
  const fake = join(dir, 'rg');
  writeFileSync(fake, '#!/bin/bash\nprintf wrong'); chmodSync(fake, 0o755);
  writeFileSync(join(dir, 'evidence.txt'), 'needle\nsecond needle\n');
  const fixture = createLocalRuntimeFixture({ type: 'shell', env: { PATH: `${dir}:${process.env.PATH}` } });
  t.after(async () => { await fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  const result = await fixture.client().grep({
    rootPath: dir, query: 'needle', literal: true, caseSensitive: false, context: 0, maxMatches: 1,
  }, scope);
  assert.equal(result.lines[0]?.path, 'evidence.txt');
  assert.equal(result.lines.length, 1);
});

test('bash and zsh are environment configuration, with no persistent cwd or export state', {
  skip: !posix || !existsSync('/bin/zsh'),
}, async (t) => {
  for (const shell of ['/bin/bash', '/bin/zsh']) {
    const fixture = createLocalRuntimeFixture({ type: 'shell', shell });
    t.after(() => fixture.close());
    assert.equal((await fixture.client().run(command('export TRANSIENT_VALUE=changed; cd /'), scope)).status, 'exited');
    const result = await fixture.client().run(command('printf "%s" "${TRANSIENT_VALUE-unset}"'), scope);
    assert.equal(result.stdout, 'unset');
  }
});

test('invalid explicit programs and ambiguous PATH entries never silently fall back', () => {
  const missingGit = join(tmpdir(), `pinpawo-missing-${process.pid}`, 'git');
  assert.throws(() => createShellEnvironment({ type: 'shell', pathBase: process.cwd(), programs: { git: missingGit } }), /not installed/);
  assert.throws(() => createShellEnvironment({ type: 'shell', env: { PATH: ['.', tmpdir()].join(delimiter) } }), /pathBase/);
});

test('cancellation reaches a descendant that ignores SIGTERM after its parent exits', { skip: !posix }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-descendant-'));
  const pidFile = join(dir, 'pid');
  const fixture = createLocalRuntimeFixture();
  let childPid: number | undefined;
  t.after(async () => {
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const childScript = 'process.on("SIGTERM",()=>{}); require("node:fs").writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000);';
  const parentScript = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}, ${JSON.stringify(pidFile)}], {stdio:'ignore'}); setInterval(()=>{},1000);`;
  const abort = new AbortController();
  const call = fixture.client().exec(argv(['-e', parentScript]), { ...scope, signal: abort.signal });
  // Observe the operation immediately so a later cancellation is never unhandled.
  const settled = call.then(() => null, (error: Error) => error);
  for (let attempt = 0; !existsSync(pidFile) && attempt < 100; attempt += 1) {
    await new Promise((resolveDone) => setTimeout(resolveDone, 20));
  }
  assert.ok(existsSync(pidFile), 'descendant must be running before cancellation');
  childPid = Number(readFileSync(pidFile, 'utf8'));
  process.kill(childPid, 0);
  abort.abort();
  assert.equal((await settled)?.name, 'AbortError');
  assert.throws(() => process.kill(childPid!, 0), { code: 'ESRCH' });
});
