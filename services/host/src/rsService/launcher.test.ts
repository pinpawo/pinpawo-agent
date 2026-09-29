import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PosixShellRS } from '../toolkits/local/posixShellRS';
import { SHELL_RS_CONTRACT, SHELL_RS_VERSION } from '../toolkits/local/shellRS';
import { createShellRSServiceHandler } from '../toolkits/local/shellRSService';
import type { RSServiceConnection } from './connection';
import { connectRSService, ensureRSService, rsServiceBootstrapEnvironment } from './launcher';
import { ensureToken, resolveRSServicePaths } from './paths';
import { startRSService } from './server';

const isWindows = process.platform === 'win32';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

/**
 * A spawned service starts the Browser extension bridge under its HOME. Point
 * HOME at the test's directory so it never touches the user's real bridge.
 */
function isolateHome(t: TestContext, home: string) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  });
}

test('concurrent launches settle on one service, which a management stop ends', { skip: isWindows }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pp-rs-'));
  isolateHome(t, root);
  const paths = resolveRSServicePaths(root);
  let servicePid = 0;
  const opened: RSServiceConnection[] = [];
  const track = <T extends RSServiceConnection | null>(connection: T): T => {
    if (connection) opened.push(connection);
    return connection;
  };
  t.after(async () => {
    // An open connection would keep the test process alive after a failure.
    await Promise.all(opened.map(async (connection) => await connection.close()));
    if (servicePid && isAlive(servicePid)) process.kill(servicePid, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(track(await connectRSService({ paths })), null, 'nothing runs before the first launch');

  const rs = { contract: SHELL_RS_CONTRACT, version: SHELL_RS_VERSION };
  const clients = (await Promise.all([
    ensureRSService({ paths, rs, startupTimeoutMs: 20_000 }),
    ensureRSService({ paths, rs, startupTimeoutMs: 20_000 }),
    ensureRSService({ paths, rs, startupTimeoutMs: 20_000 }),
  ])).map(track);
  servicePid = clients[0]!.servicePid;
  assert.notEqual(servicePid, process.pid);
  assert.deepEqual(clients.map((client) => client.servicePid), [servicePid, servicePid, servicePid]);

  // Hosts going away do not stop the service.
  await Promise.all(clients.map(async (client) => await client.close()));
  const admin = track(await connectRSService({ paths }));
  assert.ok(admin);
  const status = await admin.admin('status') as { pid: number; rs: Array<{ contract: string }> };
  assert.equal(status.pid, servicePid);
  assert.deepEqual(status.rs.map(({ contract }) => contract), [SHELL_RS_CONTRACT, 'pinpawo.browser-rs']);

  await admin.admin('stop');
  await admin.close();
  await waitUntil(() => !isAlive(servicePid));
  // The launchers discarded the candidates that lost, so none takes over.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
  assert.equal(track(await connectRSService({ paths })), null);
});

test('the service starts with a minimal environment of its own', () => {
  const env = rsServiceBootstrapEnvironment({
    HOME: '/home/u',
    PATH: '/custom/bin',
    OPENAI_API_KEY: 'secret',
    VIRTUAL_ENV: '/project/.venv',
  });
  assert.deepEqual(env, { HOME: '/home/u', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
});

async function startStaleService(root: string, build: string) {
  const paths = resolveRSServicePaths(root);
  const token = await ensureToken(paths);
  const shell = new PosixShellRS();
  const service = await startRSService({
    endpoint: paths.endpoint,
    token,
    build,
    handlers: [createShellRSServiceHandler(shell)],
    log: () => {},
  });
  return { paths, shell, service };
}

const sourceEntryArgs = [
  '--import',
  import.meta.resolve('tsx/esm'),
  fileURLToPath(new URL('../rsServiceEntry.ts', import.meta.url)),
];

test('an idle service built from other code is replaced', { skip: isWindows }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pp-rs-'));
  isolateHome(t, root);
  const { paths, service } = await startStaleService(root, 'old-build');
  let replacement: RSServiceConnection | null = null;
  t.after(async () => {
    await service.stop();
    if (replacement) {
      const pid = replacement.servicePid;
      await replacement.close();
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
    await rm(root, { recursive: true, force: true });
  });

  replacement = await ensureRSService({
    paths,
    rs: { contract: SHELL_RS_CONTRACT, version: SHELL_RS_VERSION },
    expectedBuild: 'new-build',
    entryArgs: sourceEntryArgs,
    startupTimeoutMs: 20_000,
  });
  await service.stopped;
  assert.notEqual(replacement.servicePid, process.pid);
  const admin = await connectRSService({ paths });
  assert.ok(admin);
  await admin.admin('stop');
  await admin.close();
});

test('a busy service built from other code is kept, with one warning', { skip: isWindows }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pp-rs-'));
  const { paths, shell, service } = await startStaleService(root, 'old-build');
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  const running = await shell.exec('s1', {
    command: { shell: 'sleep 5' },
    cwd: process.cwd(),
    waitMs: 50,
    onTimeout: 'yield',
    maxOutputChars: 1024,
  });
  assert.equal(running.status, 'yielded');

  const warnings: string[] = [];
  const connect = () => ensureRSService({
    paths,
    rs: { contract: SHELL_RS_CONTRACT, version: SHELL_RS_VERSION },
    expectedBuild: 'newer-build',
    entryArgs: sourceEntryArgs,
    warn: (message) => warnings.push(message),
  });
  const first = await connect();
  const second = await connect();
  t.after(async () => {
    await first.close();
    await second.close();
  });
  assert.equal(first.servicePid, process.pid);
  assert.equal(second.servicePid, process.pid);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /pinpawo rs stop/);
});
