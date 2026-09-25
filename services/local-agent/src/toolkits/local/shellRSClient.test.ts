import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RSServiceConnection } from '../../rsService/connection';
import type { RSContractClient } from '../../rsService/contractClient';
import { ensureToken, resolveRSServicePaths } from '../../rsService/paths';
import { startRSService } from '../../rsService/server';
import { createBashToolkit } from './index';
import { PosixShellRS } from './posixShellRS';
import { ShellRSClient } from './shellRSClient';
import { SHELL_RS_CONTRACT, SHELL_RS_VERSION, ShellRSError } from './shellRS';
import { SHELL_RS_MANAGEMENT, createShellRSServiceHandler } from './shellRSService';

const isWindows = process.platform === 'win32';

const exec = {
  cwd: process.cwd(),
  waitMs: 5_000,
  onTimeout: 'terminate' as const,
  maxOutputChars: 4096,
};

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pp-rs-'));
  const paths = resolveRSServicePaths(root);
  const token = await ensureToken(paths);
  const service = await startRSService({
    endpoint: paths.endpoint,
    token,
    handlers: [createShellRSServiceHandler(new PosixShellRS())],
    log: () => {},
  });
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  // A "Host": its own client of the shared service.
  const host = () => {
    const rs = new ShellRSClient({
      connect: async () => await RSServiceConnection.open({
        paths,
        token,
        rs: { contract: SHELL_RS_CONTRACT, version: SHELL_RS_VERSION },
      }),
    });
    t.after(async () => await rs.dispose());
    return rs;
  };
  const admin = async () => {
    const connection = await RSServiceConnection.open({ paths, token });
    t.after(async () => await connection.close());
    return connection;
  };
  return { host, admin, service };
}

test('the client runs commands exactly as the implementation does', { skip: isWindows }, async (t) => {
  const { host } = await setup(t);
  const shell = host();
  await shell.start();
  assert.deepEqual(await shell.status(), { available: true });

  assert.deepEqual(
    await shell.exec('s1', { ...exec, command: { shell: 'printf a && printf b' } }),
    { status: 'exited', code: 0, stdout: 'ab', stderr: '' },
  );
  const viaArgv = await shell.exec('s1', {
    ...exec,
    command: { argv: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', '$HOME && x'] },
  });
  assert.equal(viaArgv.status === 'exited' ? viaArgv.stdout : null, '$HOME && x');

  const missing = await shell.exec('s1', { ...exec, command: { argv: ['pinpawo-no-such-binary'] } });
  assert.equal(missing.status, 'spawn_failed');
  assert.ok(missing.status === 'spawn_failed' && missing.error instanceof Error);
});

test('commands run in the calling Host environment with the request env on top', { skip: isWindows }, async (t) => {
  const { host } = await setup(t);
  const shell = host();
  process.env.PINPAWO_RS_HOST_VAR = 'from-host';
  t.after(() => { delete process.env.PINPAWO_RS_HOST_VAR; });

  const result = await shell.exec('s1', {
    ...exec,
    env: { PINPAWO_RS_CALL_VAR: 'from-call' },
    command: { shell: 'printf "%s,%s" "$PINPAWO_RS_HOST_VAR" "$PINPAWO_RS_CALL_VAR"' },
  });
  assert.equal(result.status === 'exited' ? result.stdout : null, 'from-host,from-call');
});

test('sessions outlive the Host that started them', { skip: isWindows }, async (t) => {
  const { host } = await setup(t);
  const first = host();
  const started = await first.exec('agent-session-1', {
    ...exec,
    waitMs: 100,
    onTimeout: 'yield',
    command: { shell: 'echo early; sleep 0.5; echo late' },
  });
  assert.equal(started.status, 'yielded');
  if (started.status !== 'yielded') return;
  // The first Host goes away; its session and process stay in the service.
  await first.dispose();

  const restarted = host();
  assert.deepEqual(
    (await restarted.list('agent-session-1')).map(({ processId }) => processId),
    [started.process.processId],
  );
  const finished = await restarted.wait('agent-session-1', started.process.processId, 5_000);
  assert.equal(finished.process.status, 'exited');
  assert.equal(finished.stdout, 'late\n');

  // Another Agent session still cannot reach it.
  await assert.rejects(
    restarted.read('agent-session-2', started.process.processId),
    (error: unknown) => error instanceof ShellRSError && error.code === 'other_session',
  );
});

test('cancellation reaches the command in the service', { skip: isWindows }, async (t) => {
  const { host } = await setup(t);
  const shell = host();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const result = await shell.exec('s1', {
    ...exec,
    signal: controller.signal,
    command: { shell: 'sleep 5' },
  });
  assert.equal(result.status, 'aborted');
});

test('a lost connection reports an unknown result and keeps the started command', { skip: isWindows }, async (t) => {
  const { host } = await setup(t);
  const shell = host();
  await shell.start();

  const pending = shell.exec('s1', {
    ...exec,
    waitMs: 200,
    onTimeout: 'yield',
    command: { shell: 'sleep 3' },
  });
  // Drop this Host's connection while the command is running.
  setTimeout(() => {
    void (shell as unknown as { transport: RSContractClient }).transport.currentConnection!.close();
  }, 50);
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof ShellRSError && error.code === 'result_unknown',
  );

  // The command was not retried, and it is still held by its session.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  const processes = await shell.list('s1');
  assert.equal(processes.length, 1);
  assert.equal(processes[0]!.status, 'running');
  await shell.terminate('s1', processes[0]!.processId);
});

test('an unreachable service makes shell Toolkits unavailable without failing', { skip: isWindows }, async () => {
  const shell = new ShellRSClient({
    connect: async () => { throw Object.assign(new Error('no service'), { code: 'ECONNREFUSED' }); },
  });
  await assert.rejects(shell.start());
  const availability = await shell.status();
  assert.equal(availability.available, false);
  assert.match(availability.available ? '' : availability.reason, /ShellRS service is unavailable: no service/);

  const toolkit = createBashToolkit({ shell });
  assert.equal((await toolkit.availability!()).available, false);
  await assert.rejects(
    shell.exec('s1', { ...exec, command: { shell: 'true' } }),
    (error: unknown) => error instanceof ShellRSError && error.code === 'unavailable',
  );
});

test('on Windows the client reports ShellRS unavailable without starting a service', async () => {
  const shell = new ShellRSClient({ platform: 'win32' });
  await assert.rejects(shell.start(), /no Windows implementation/);
  const availability = await shell.status();
  assert.equal(availability.available, false);
  assert.match(availability.available ? '' : availability.reason, /no Windows implementation/);
});

test('management lists and terminates processes across sessions', { skip: isWindows }, async (t) => {
  const { host, admin } = await setup(t);
  const shell = host();
  const started = await shell.exec('agent-session-9', {
    ...exec,
    waitMs: 50,
    onTimeout: 'yield',
    command: { shell: 'sleep 5' },
  });
  assert.equal(started.status, 'yielded');
  if (started.status !== 'yielded') return;

  const channel = await admin();
  const listed = await channel.admin('manage', {
    contract: SHELL_RS_CONTRACT,
    name: SHELL_RS_MANAGEMENT.processes,
    args: {},
  }) as Array<{ processId: string; agentSessionId: string; status: string }>;
  assert.deepEqual(
    listed.map(({ processId, agentSessionId, status }) => ({ processId, agentSessionId, status })),
    [{ processId: started.process.processId, agentSessionId: 'agent-session-9', status: 'running' }],
  );

  const terminated = await channel.admin('manage', {
    contract: SHELL_RS_CONTRACT,
    name: SHELL_RS_MANAGEMENT.terminate,
    args: { processId: started.process.processId },
  }) as { status: string };
  assert.equal(terminated.status, 'terminated');

  const status = await channel.admin('status') as { rs: Array<{ details: Record<string, number> }> };
  assert.equal(status.rs[0]!.details.running, 0);
});

test('stopping the service ends its sessions and reports what it cleaned up', { skip: isWindows }, async (t) => {
  const { host, admin } = await setup(t);
  const shell = host();
  const started = await shell.exec('s1', { ...exec, waitMs: 50, onTimeout: 'yield', command: { shell: 'sleep 5' } });
  assert.equal(started.status, 'yielded');

  const report = await (await admin()).admin('stop');
  assert.deepEqual(report, { rs: [{ contract: SHELL_RS_CONTRACT, report: { terminated: 1 } }] });
});
