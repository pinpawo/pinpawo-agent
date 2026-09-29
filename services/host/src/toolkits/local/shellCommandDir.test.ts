import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { PosixShellRS } from './posixShellRS';
import { classifyReadOnlyShellCommand } from './readOnlyShell';
import { prepareShellCommandDir } from './shellCommandDir';

const isWindows = process.platform === 'win32';

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pp-rg-'));
  const commandDir = await prepareShellCommandDir(join(root, 'bin'));
  const project = join(root, 'project');
  await mkdir(join(project, '.pinpawo'), { recursive: true });
  await writeFile(join(project, 'a.txt'), 'needle\n');
  await writeFile(join(project, '.pinpawo', 'checkpoint.json'), 'needle\n');
  await writeFile(join(project, 'long.txt'), `needle ${'x'.repeat(5_000)}\n`);
  const shell = new PosixShellRS({ commandDir });
  t.after(async () => {
    await shell.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const run = async (command: string) => {
    const result = await shell.exec('s1', {
      command: { shell: command },
      cwd: project,
      waitMs: 10_000,
      onTimeout: 'terminate',
      maxOutputChars: 100_000,
      // No rg on this PATH: only the RS's own can answer.
      env: { PATH: '/usr/bin:/bin' },
    });
    assert.equal(result.status, 'exited');
    return result.status === 'exited' ? result.stdout : '';
  };
  return { run };
}

test('commands in the RS find the bundled rg first on PATH', { skip: isWindows }, async (t) => {
  const { run } = await setup(t);
  assert.match(await run('rg --version'), /^ripgrep /);
});

test('the RS rg never searches .pinpawo, even with --hidden', { skip: isWindows }, async (t) => {
  const { run } = await setup(t);
  assert.deepEqual((await run('rg -l --hidden --sort path needle')).trim().split('\n'), ['a.txt', 'long.txt']);
  assert.doesNotMatch(await run('rg --files --hidden'), /\.pinpawo/);
});

test('the RS rg shortens very long lines', { skip: isWindows }, async (t) => {
  const { run } = await setup(t);
  const output = await run('rg -n needle long.txt');
  assert.match(output, /omitted end of long line/);
  assert.ok(output.length < 3_000);
});

test('the searches the Toolkits recommend are admitted by inspect_shell', () => {
  for (const command of [
    'rg -n "pattern" src',
    'rg --files -g "*.ts"',
    'rg -l -F -i "Foo" | head -20',
    'cd src && rg -n -C 2 "foo" -g "*.ts"',
    'jq ".scripts" package.json',
  ]) {
    assert.deepEqual(classifyReadOnlyShellCommand(command), { allowed: true }, command);
  }
});
