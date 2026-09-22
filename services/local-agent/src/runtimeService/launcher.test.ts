import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureRuntimeService, connectRuntimeService } from './launcher';
import { runtimeServicePaths } from './config';
import type { RuntimeClient } from './client';
import type { RuntimeExecution } from './types';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
        shared: { type: 'shell', pathBase: directory, env: { PINPAWO_TEST_ENVIRONMENT: 'shared' } },
        isolated: { type: 'shell', pathBase: directory, env: { PINPAWO_TEST_ENVIRONMENT: 'isolated' } },
        example: { type: 'example' },
      },
      toolkitBindings: { bash: 'shared', git: 'shared', inspection: 'isolated', extension: 'example' },
      modules: [modulePath],
    }));
    const [a, b] = await Promise.all([
      ensureRuntimeService({ directory, toolkits: { bash: 'shell', git: 'shell', extension: 'example' } }),
      ensureRuntimeService({ directory, toolkits: { bash: 'shell', inspection: 'shell' } }),
    ]);
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
    await rm(directory, { recursive: true, force: true });
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
    await rm(directory, { recursive: true, force: true });
  }
});
