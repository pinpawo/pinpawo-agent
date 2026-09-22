import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBashToolkit, createGitToolkit } from './index';
import { runShellTool, inspectShellTool } from './shellTools';
import { writeFileTool } from './fileTools';
import { gitStatusTool } from './gitTools';
import { createLocalRuntimeFixture, testExecution } from './shellTestSupport';
import { prepareLocalToolInput } from './workdirBinding';
import { normalizeShellAuthorizationInput } from './shellTools';

test('shared instance uses each invocation workdir without mutating shared cwd', async (t) => {
  const a = mkdtempSync(join(tmpdir(), 'shell-scope-a-'));
  const b = mkdtempSync(join(tmpdir(), 'shell-scope-b-'));
  const fixture = createLocalRuntimeFixture();
  t.after(async () => { await fixture.close(); rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); });
  const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.cwd())"`;
  const [first, second] = await Promise.all([
    fixture.invoke(runShellTool, { command }, undefined, testExecution({ workdir: a }), 'bash', 'a'),
    fixture.invoke(runShellTool, { command }, undefined, testExecution({ workdir: b }), 'bash', 'b'),
  ]);
  assert.equal(first, realpathSync(a));
  assert.equal(second, realpathSync(b));
  await fixture.invoke(writeFileTool, { path: 'result.txt', content: 'a' }, undefined, testExecution({ workdir: a }));
  assert.equal(readFileSync(join(a, 'result.txt'), 'utf8'), 'a');
  await fixture.environment.releaseClient('a');
  assert.equal(await fixture.invoke(runShellTool, { command }, undefined, testExecution({ workdir: b }), 'bash', 'b'), realpathSync(b));
});

test('Toolkit preparation resolves targets before review, including inspect_shell and Git', async () => {
  const workdir = process.cwd();
  const executionScope = testExecution({ workdir });
  for (const [toolkit, name] of [[createBashToolkit(), 'inspect_shell'], [createGitToolkit(), 'git_status']] as const) {
    const definition = toolkit.tools.find(({ tool }) => tool.name === name)!;
    assert.ok(definition.prepareInput);
    const input = await definition.prepareInput({ command: 'pwd', cwd: 'src' }, {
      toolkitName: toolkit.name, toolName: name, executionScope,
    });
    assert.equal((input as { cwd: string }).cwd, join(workdir, 'src'));
  }
  assert.deepEqual(prepareLocalToolInput('read_file', { path: 'README.md' }, workdir), { path: join(workdir, 'README.md') });
  assert.throws(() => prepareLocalToolInput('inspect_shell', { command: 'pwd' }, null), /absolute execution workdir/);
  assert.equal(createBashToolkit().runtime, 'shell');
  assert.equal(createGitToolkit().runtime, 'shell');
});

test('Git and inspect_shell use prepared cwd instead of the Host or service directory', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'shell-scope-git-'));
  const fixture = createLocalRuntimeFixture();
  t.after(async () => { await fixture.close(); rmSync(directory, { recursive: true, force: true }); });
  const scope = testExecution({ workdir: directory });
  assert.match(String(await fixture.invoke(gitStatusTool, {}, undefined, scope)), /not a git repository/i);
  if (process.platform !== 'win32') assert.equal(await fixture.invoke(inspectShellTool, { command: 'pwd' }, undefined, scope), realpathSync(directory));
});

test('empty and whitespace file paths cannot bypass workdir preparation', () => {
  for (const name of ['read_file', 'write_file', 'mkdir_path']) {
    assert.throws(() => prepareLocalToolInput(name, { path: '' }, process.cwd()), /must not be empty/);
    assert.throws(() => prepareLocalToolInput(name, { path: '   ' }, null), /absolute execution workdir/);
    assert.equal(prepareLocalToolInput(name, { path: '   ' }, process.cwd()).path, join(process.cwd(), '   '));
  }
});

test('review and execution preserve spaces in a prepared cwd exactly', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shell-cwd-space-'));
  const cwd = join(root, 'repo ');
  mkdirSync(cwd); mkdirSync(join(root, 'repo'));
  const fixture = createLocalRuntimeFixture();
  t.after(async () => { await fixture.close(); rmSync(root, { recursive: true, force: true }); });
  const command = `${JSON.stringify(process.execPath)} -e "console.log(JSON.stringify(process.cwd()))"`;
  const input = prepareLocalToolInput('run_shell', { cwd: 'repo ', command }, root);
  assert.equal(normalizeShellAuthorizationInput(input).cwd, cwd);
  const result = await fixture.invoke(runShellTool, input, undefined, testExecution({ workdir: root }));
  assert.equal(JSON.parse(String(result)), realpathSync(cwd));
});
