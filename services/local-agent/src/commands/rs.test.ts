import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RSServiceConnection } from '../rsService/connection';
import { ensureToken, resolveRSServicePaths } from '../rsService/paths';
import { startRSService } from '../rsService/server';
import { PosixShellRS } from '../toolkits/local/posixShellRS';
import { RemoteShellRS } from '../toolkits/local/remoteShellRS';
import { SHELL_RS_CONTRACT, SHELL_RS_VERSION } from '../toolkits/local/shellRS';
import { createShellRSServiceHandler } from '../toolkits/local/shellRSService';
import { runRSCommand } from './rs';

const isWindows = process.platform === 'win32';

test('rs management reports, lists, terminates and stops', { skip: isWindows }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pp-rs-'));
  const paths = resolveRSServicePaths(root);
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const output: unknown[] = [];
  const run = async (action: string, argument?: string, session?: string) => {
    await runRSCommand(action, argument, {
      paths,
      ...(session ? { session } : {}),
      write: (text) => output.push(JSON.parse(text)),
    });
    return output.at(-1) as Record<string, unknown> & Array<{ processId: string }>;
  };

  assert.deepEqual(await run('status'), { running: false, endpoint: paths.endpoint });
  await assert.rejects(run('processes'), /not running/);

  const token = await ensureToken(paths);
  const service = await startRSService({
    endpoint: paths.endpoint,
    token,
    handlers: [createShellRSServiceHandler(new PosixShellRS())],
    log: () => {},
  });
  t.after(async () => { await service.stop(); });
  const shell = new RemoteShellRS({
    connect: async () => await RSServiceConnection.open({
      paths,
      token,
      rs: { contract: SHELL_RS_CONTRACT, version: SHELL_RS_VERSION },
    }),
  });
  t.after(async () => await shell.dispose());
  const started = await shell.exec('agent-a', {
    command: { shell: 'sleep 5' },
    cwd: process.cwd(),
    waitMs: 50,
    onTimeout: 'yield',
    maxOutputChars: 1024,
  });
  assert.equal(started.status, 'yielded');
  if (started.status !== 'yielded') return;

  const status = await run('status');
  assert.equal(status.running, true);
  assert.equal(status.pid, process.pid);

  assert.deepEqual(
    (await run('processes', undefined, 'agent-a')).map((entry) => entry.processId),
    [started.process.processId],
  );
  assert.deepEqual(await run('processes', undefined, 'agent-b'), []);

  const terminated = await run('terminate', started.process.processId);
  assert.equal(terminated.status, 'terminated');
  assert.equal(terminated.agentSessionId, 'agent-a');

  const stopped = await run('stop');
  assert.equal(stopped.stopped, true);
  await service.stopped;
  await assert.rejects(run('restart'), /Unknown rs action/);
});
