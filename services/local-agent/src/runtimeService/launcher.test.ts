import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ensureRuntimeService, connectRuntimeService, runtimeServiceBootstrapEnvironment } from './launcher';
import { runtimeServicePaths } from './config';
import type { RuntimeClient } from './client';
import type { RuntimeExecution } from './types';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('persistent service bootstrap excludes Host secrets and Node preload hooks', () => {
  const env = runtimeServiceBootstrapEnvironment({
    HOME: '/home/test', PATH: '/project/bin', GH_TOKEN: 'project-secret',
    NODE_OPTIONS: '--import=/project/preload.js', PINPAWO_TEST_PRIVATE_SECRET: 'project-secret',
  });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.PINPAWO_TEST_PRIVATE_SECRET, undefined);
  if (process.platform !== 'win32') assert.notEqual(env.PATH, '/project/bin');
});

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function killTestCandidate(pid: number | undefined): Promise<void> {
  if (!pid || !isProcessAlive(pid)) return;
  process.kill(pid, 'SIGKILL');
  for (let attempt = 0; attempt < 250 && isProcessAlive(pid); attempt += 1) await delay(20);
  assert.equal(isProcessAlive(pid), false, 'The test candidate did not exit.');
}

async function removeTestSocketDirectory(paths: ReturnType<typeof runtimeServicePaths>, servicePid?: number): Promise<void> {
  if (process.platform === 'win32') return;
  // stopService acknowledges before shutdown finishes. Only remove this
  // fixture's private socket directory after its known service has exited.
  if (servicePid) {
    for (let attempt = 0; attempt < 500 && isProcessAlive(servicePid); attempt += 1) await delay(20);
    assert.equal(isProcessAlive(servicePid), false, 'Preserving the socket directory because the test service is still running.');
  }
  await rm(dirname(paths.endpoint), { recursive: true, force: true });
}

test('concurrent Hosts use one independent service, shared shell environments and a registered extension', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ppr-host-'));
  const paths = runtimeServicePaths(directory);
  const clients: RuntimeClient[] = [];
  let admin: RuntimeClient | undefined;
  try {
    const modulePath = join(directory, 'example.mjs');
    await writeFile(modulePath, `export const runtimeFactories = {
      example: () => ({
        async call(method, args, context) {
          if (method !== 'identity') throw new Error('Unknown operation');
          return { pid: process.pid, clientId: context.clientId, value: args };
        },
        async releaseClient() {}, async close() {}, diagnose() { return { ready: true }; }
      })
    };`);
    await writeFile(paths.config, JSON.stringify({
      instances: {
        shared: { kind: 'shell', pathBase: directory, env: { PINPAWO_TEST_ENVIRONMENT: 'shared' } },
        isolated: { kind: 'shell', pathBase: directory, env: { PINPAWO_TEST_ENVIRONMENT: 'isolated' } },
        example: { kind: 'example' },
      },
      toolkitBindings: { bash: 'shared', git: 'shared', inspection: 'isolated', extension: 'example' },
      modules: [modulePath],
    }));
    const previousSecret = process.env.PINPAWO_TEST_PRIVATE_SECRET;
    process.env.PINPAWO_TEST_PRIVATE_SECRET = 'must-not-cross-hosts';
    let a: RuntimeClient;
    let b: RuntimeClient;
    try {
      [a, b] = await Promise.all([
        ensureRuntimeService({ directory, requirements: { bash: 'shell', git: 'shell', extension: 'example' } }),
        ensureRuntimeService({ directory, requirements: { bash: 'shell', inspection: 'shell' } }),
      ]);
    } finally {
      if (previousSecret === undefined) delete process.env.PINPAWO_TEST_PRIVATE_SECRET;
      else process.env.PINPAWO_TEST_PRIVATE_SECRET = previousSecret;
    }
    clients.push(a, b);
    assert.equal(a.pid, b.pid);
    assert.notEqual(a.pid, process.pid);
    assert.notEqual(a.clientId, b.clientId);
    const scope: RuntimeExecution = {
      threadId: 'same-thread', taskId: 'task', runId: 'same-run', delegationId: 'same-delegation', workdir: directory,
    };
    const command = process.platform === 'win32'
      ? '[Console]::Write($env:PINPAWO_TEST_ENVIRONMENT)'
      : 'printf "%s" "$PINPAWO_TEST_ENVIRONMENT"';
    const run = { command, cwd: directory, timeoutMs: 1000, maxOutputChars: 1000 };
    const [shellA, gitA, shellB, isolated] = await Promise.all([
      a.call('bash', 'shell.run', run, scope), a.call('git', 'shell.run', run, scope),
      b.call('bash', 'shell.run', run, scope), b.call('inspection', 'shell.run', run, scope),
    ]) as Array<{ status: string; stdout: string }>;
    assert.equal(shellA.stdout, 'shared');
    assert.equal(gitA.stdout, shellA.stdout);
    assert.equal(shellB.stdout, shellA.stdout);
    assert.equal(isolated.stdout, 'isolated');
    const secretCommand = process.platform === 'win32'
      ? '[Console]::Write($env:PINPAWO_TEST_PRIVATE_SECRET)'
      : 'printf "%s" "$PINPAWO_TEST_PRIVATE_SECRET"';
    assert.equal((await a.call('bash', 'shell.run', { ...run, command: secretCommand }, scope) as { stdout: string }).stdout, '');
    const extension = await a.call('extension', 'identity', { result: 'ok' }, scope) as { pid: number; clientId: string };
    assert.equal(extension.pid, a.pid);
    assert.equal(extension.clientId, a.clientId);
    await a.close();
    assert.equal((await b.call('bash', 'shell.run', run, scope) as { stdout: string }).stdout, 'shared');
    admin = await connectRuntimeService({ directory, administrative: true });
    assert.equal((await admin.status()).pid, b.pid);
    await b.close();
    assert.equal((await admin.status()).pid, b.pid, 'last Host exit leaves service alive');
    await admin.stopService();
    await admin.close();
    admin = undefined;
    for (let i = 0; i < 500; i += 1) {
      try { await stat(paths.lock); } catch { break; }
      await delay(20);
    }
    await assert.rejects(stat(paths.lock), { code: 'ENOENT' });
  } catch (error) {
    // Include startup diagnostics only; never print the token or environment.
    const log = await readFile(paths.log, 'utf8').catch(() => '');
    if (log) process.stderr.write(log);
    throw error;
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    admin ??= await connectRuntimeService({ directory, administrative: true }).catch(() => undefined);
    if (admin) {
      await admin.stopService().catch(() => undefined);
      await admin.close();
    }
    // Lock release precedes process exit; Windows still holds cwd briefly.
    await removeTestSocketDirectory(paths, admin?.pid ?? clients[0]?.pid);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a killed service is replaced after its lock expires and the old connection stays invalid', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ppr-restart-'));
  const paths = runtimeServicePaths(directory);
  let client: RuntimeClient | undefined;
  let replacement: RuntimeClient | undefined;
  try {
    client = await ensureRuntimeService({ directory, administrative: true });
    const previousId = client.clientId;
    const previousPid = client.pid;
    assert.notEqual(previousPid, process.pid);
    process.kill(previousPid, 'SIGKILL');
    for (let i = 0; i < 500 && client.isConnected; i += 1) await delay(10);
    assert.equal(client.isConnected, false);
    await assert.rejects(client.status(), { code: 'connection_lost' });
    replacement = await ensureRuntimeService({ directory, administrative: true });
    assert.notEqual(replacement.pid, previousPid);
    assert.notEqual(replacement.clientId, previousId);
    assert.equal((await replacement.status()).pid, replacement.pid);
    await assert.rejects(client.status(), { code: 'connection_lost' });
    await replacement.stopService();
    for (let i = 0; i < 500; i += 1) {
      try { await stat(paths.lock); } catch { break; }
      await delay(20);
    }
    await assert.rejects(stat(paths.lock), { code: 'ENOENT' });
  } finally {
    await client?.close();
    if (replacement?.isConnected) await replacement.stopService().catch(() => undefined);
    await replacement?.close();
    await removeTestSocketDirectory(paths, replacement?.pid ?? client?.pid);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a late startup candidate exits before ensure returns and cannot revive a stopped service', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ppr-late-'));
  const paths = runtimeServicePaths(directory);
  const pidPath = join(directory, 'candidate.pid');
  const releasePath = join(directory, 'release-candidate');
  const preloadPath = join(directory, 'delay-candidate.mjs');
  const clients: RuntimeClient[] = [];
  let candidatePid: number | undefined;
  let lateLaunch: Promise<RuntimeClient> | undefined;
  let admin: RuntimeClient | undefined;

  const waitFor = async (check: () => Promise<boolean>, message: string, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(20);
    }
    assert.fail(message);
  };
  const isCandidateAlive = () => {
    if (candidatePid === undefined) return false;
    try { process.kill(candidatePid, 0); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  const lockIsGone = async () => {
    try { await stat(paths.lock); return false; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  };
  try {
    await writeFile(paths.config, JSON.stringify({ instances: {}, toolkitBindings: {} }));
    await writeFile(preloadPath, `
import { writeFile, stat } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
await writeFile(${JSON.stringify(pidPath)}, String(process.pid));
const deadline = Date.now() + 45_000;
while (true) {
  try { await stat(${JSON.stringify(releasePath)}); break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (Date.now() >= deadline) throw new Error('Test candidate was never released.');
  await setTimeout(20);
}
`);
    // Start the delayed candidate first and observe its marker before starting
    // the winner. Its preloader cannot reach entry.ts until explicitly released.
    lateLaunch = ensureRuntimeService({
      directory,
      bootstrapEnv: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(preloadPath).href].filter(Boolean).join(' '),
      },
    });
    void lateLaunch.catch(() => {}); // Cleanup awaits a failed launch as well.
    await waitFor(async () => {
      try {
        const value = Number((await readFile(pidPath, 'utf8')).trim());
        if (!Number.isSafeInteger(value) || value <= 0) return false;
        candidatePid = value;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    }, 'The delayed startup candidate did not reach its preloader.');
    assert.ok(isCandidateAlive());

    const winner = await ensureRuntimeService({ directory });
    clients.push(winner);
    const joined = await lateLaunch;
    clients.push(joined);
    assert.equal(joined.pid, winner.pid);
    assert.notEqual(winner.pid, candidatePid);
    assert.equal(isCandidateAlive(), false, 'ensure must reap its redundant child before returning');

    admin = await connectRuntimeService({ directory, administrative: true });
    await admin.stopService();
    await admin.close();
    admin = undefined;
    await waitFor(lockIsGone, 'The stopped test service did not release its lock.');
    // Keep the namespace intact and release the gate: deleting the directory
    // here would conceal an orphan candidate starting a replacement service.
    await writeFile(releasePath, 'released');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await delay(50);
      assert.equal(await lockIsGone(), true, 'A late candidate recreated the service lock');
      await assert.rejects(connectRuntimeService({ directory }), (error: unknown) => (
        ['ENOENT', 'ECONNREFUSED'].includes(String((error as NodeJS.ErrnoException).code))
      ));
    }
  } finally {
    // This PID was emitted by this test's gated child, never read from service
    // diagnostics or a shared lock. Kill it before releasing/removing its gate.
    if (isCandidateAlive()) {
      process.kill(candidatePid!, 'SIGKILL');
      await waitFor(async () => !isCandidateAlive(), 'The test candidate did not exit.');
    }
    const lateClient = await lateLaunch?.catch(() => undefined);
    if (lateClient) clients.push(lateClient);
    await Promise.all(clients.map((client) => client.close()));
    admin ??= await connectRuntimeService({ directory, administrative: true }).catch((error: unknown) => {
      if (['ENOENT', 'ECONNREFUSED'].includes(String((error as NodeJS.ErrnoException).code))) return undefined;
      throw error;
    });
    if (admin) {
      try { await admin.stopService(); } finally { await admin.close(); }
    }
    await waitFor(lockIsGone, 'Preserving the test directory because its service lock remains.');
    await removeTestSocketDirectory(paths);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

for (const phase of ['module', 'preload'] as const) {
  test(`startup timeout reaps a delayed ${phase} before rejecting and cannot start a service later`, { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ppr-timeout-'));
    const paths = runtimeServicePaths(directory);
    const pidPath = join(directory, 'candidate.pid');
    const releasePath = join(directory, 'release-candidate');
    const modulePath = join(directory, 'delayed.mjs');
    let pid: number | undefined;
    try {
      await writeFile(modulePath, `
import { writeFile, stat } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
${phase === 'preload' ? "process.on('SIGTERM', () => {});" : ''}
await writeFile(${JSON.stringify(pidPath)}, String(process.pid));
const deadline = Date.now() + 15_000;
while (true) {
  try { await stat(${JSON.stringify(releasePath)}); break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (Date.now() >= deadline) throw new Error('Test candidate was never released.');
  await setTimeout(20);
}
export const runtimeFactories = {};
`);
      await writeFile(paths.config, JSON.stringify({
        instances: {}, toolkitBindings: {}, ...(phase === 'module' ? { modules: [modulePath] } : {}),
      }));
      await assert.rejects(ensureRuntimeService({
        directory, startupTimeoutMs: 4000,
        ...(phase === 'preload' ? { bootstrapEnv: {
          ...process.env,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(modulePath).href].filter(Boolean).join(' '),
        } } : {}),
      }), { code: 'startup_failed' });
      pid = Number((await readFile(pidPath, 'utf8')).trim());
      assert.ok(Number.isSafeInteger(pid) && pid > 0, 'The candidate must reach its delayed initialization.');
      assert.equal(isProcessAlive(pid), false, 'The startup promise must wait for its own child to exit.');

      // Keep the namespace and release the gate after rejection. Removing it
      // first would hide an orphan starting a service with stale configuration.
      await writeFile(releasePath, 'released');
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await delay(50);
        await assert.rejects(connectRuntimeService({ directory }), (error: unknown) => (
          ['ENOENT', 'ECONNREFUSED'].includes(String((error as NodeJS.ErrnoException).code))
        ));
      }
    } finally {
      // Only use the PID emitted by this fixture, never shared lock contents.
      pid ??= Number(await readFile(pidPath, 'utf8').catch(() => '')) || undefined;
      await killTestCandidate(pid);
      await removeTestSocketDirectory(paths);
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

test('binding failure reaps a new candidate while preserving an established service', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ppr-binding-'));
  const paths = runtimeServicePaths(directory);
  const pidPath = join(directory, 'candidate.pid');
  const modulePath = join(directory, 'identity.mjs');
  let pid: number | undefined;
  let owner: RuntimeClient | undefined;
  try {
    await writeFile(modulePath, `
import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(pidPath)}, String(process.pid));
export const runtimeFactories = {};
`);
    await writeFile(paths.config, JSON.stringify({ instances: {}, toolkitBindings: {}, modules: [modulePath] }));
    await assert.rejects(ensureRuntimeService({ directory, requirements: { bash: 'shell' } }), { code: 'binding_mismatch' });
    pid = Number((await readFile(pidPath, 'utf8')).trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.equal(isProcessAlive(pid), false, 'A failed handshake must not leave this launcher\'s candidate running.');

    owner = await ensureRuntimeService({ directory, administrative: true });
    await assert.rejects(ensureRuntimeService({ directory, requirements: { bash: 'shell' } }), { code: 'binding_mismatch' });
    assert.equal((await owner.status()).pid, owner.pid, 'An existing owner must survive a different Host\'s binding error.');
  } finally {
    if (owner) {
      await owner.stopService().catch(() => undefined);
      await owner.close();
    }
    await killTestCandidate(pid);
    await removeTestSocketDirectory(paths, owner?.pid);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
