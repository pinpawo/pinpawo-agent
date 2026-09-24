import assert from 'node:assert/strict';
import test from 'node:test';
import { createBashToolkit, createGitToolkit, createProjectInspectionToolkit } from './index';
import { PosixShellRS } from './posixShellRS';
import { SHELL_RS_REQUIREMENT, ShellRSError } from './shellRS';

const isWindows = process.platform === 'win32';

const exec = {
  cwd: process.cwd(),
  waitMs: 5_000,
  onTimeout: 'terminate' as const,
  maxOutputChars: 4096,
};

test('ShellRS runs shell strings and argv vectors', { skip: isWindows }, async (t) => {
  const shell = new PosixShellRS();
  t.after(async () => await shell.dispose());

  const viaShell = await shell.exec('s1', { ...exec, command: { shell: 'printf a && printf b' } });
  assert.deepEqual(viaShell, { status: 'exited', code: 0, stdout: 'ab', stderr: '' });

  // argv reaches the program verbatim, with no shell expansion in between.
  const viaArgv = await shell.exec('s1', {
    ...exec,
    command: { argv: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', '$HOME && x'] },
  });
  assert.equal(viaArgv.status, 'exited');
  assert.equal(viaArgv.status === 'exited' ? viaArgv.stdout : null, '$HOME && x');

  const withEnv = await shell.exec('s1', {
    ...exec,
    env: { PINPAWO_RS_TEST: 'set' },
    command: { argv: [process.execPath, '-e', 'process.stdout.write(process.env.PINPAWO_RS_TEST)'] },
  });
  assert.equal(withEnv.status === 'exited' ? withEnv.stdout : null, 'set');

  const missing = await shell.exec('s1', { ...exec, command: { argv: ['pinpawo-no-such-binary'] } });
  assert.equal(missing.status, 'spawn_failed');
});

test('a yielded command is held in the logical session of its Agent session', { skip: isWindows }, async (t) => {
  const shell = new PosixShellRS();
  t.after(async () => await shell.dispose());

  const result = await shell.exec('session-a', {
    ...exec,
    waitMs: 100,
    onTimeout: 'yield',
    command: { shell: 'echo early; sleep 5' },
  });
  assert.equal(result.status, 'yielded');
  if (result.status !== 'yielded') return;
  assert.equal(result.process.status, 'running');

  assert.deepEqual((await shell.list('session-a')).map(({ processId }) => processId), [result.process.processId]);
  assert.deepEqual(await shell.list('session-b'), []);
  await assert.rejects(
    shell.read('session-b', result.process.processId),
    (error: unknown) => error instanceof ShellRSError && error.code === 'other_session',
  );
  const terminated = await shell.terminate('session-a', result.process.processId);
  assert.equal(terminated.status, 'terminated');
});

test('ShellRS reports itself unavailable on Windows, and so do shell Toolkits', async () => {
  const shell = new PosixShellRS({ platform: 'win32' });
  const availability = shell.status();
  assert.equal(availability.available, false);
  assert.match(availability.available ? '' : availability.reason, /Windows/);
  assert.throws(() => shell.ensureSession('s1'), /Windows/);

  for (const toolkit of [
    createBashToolkit({ shell }),
    createGitToolkit({ shell }),
    createProjectInspectionToolkit({ shell }),
  ]) {
    assert.deepEqual(toolkit.requires, { shell: SHELL_RS_REQUIREMENT });
    assert.equal((await toolkit.availability?.())?.available, false, toolkit.name);
  }
});

test('ensureSession is idempotent and use never closes a session', { skip: isWindows }, async (t) => {
  const shell = new PosixShellRS();
  t.after(async () => await shell.dispose());
  shell.ensureSession('s1');
  shell.ensureSession('s1');
  assert.throws(() => shell.ensureSession(' '), /requires an Agent session id/);
  await shell.exec('s1', { ...exec, command: { shell: 'true' } });
  assert.deepEqual(shell.status(), { available: true });
});
