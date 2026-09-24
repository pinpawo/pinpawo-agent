import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { ToolMessage } from '@langchain/core/messages';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import { createBashToolkit, createGitToolkit, PosixShellRS } from './index';

function call(workdir: string, suffix: string) {
  return {
    context: {
      executionScope: {
        threadId: `thread-${suffix}`,
        taskId: `task-${suffix}`,
        runId: `run-${suffix}`,
        delegationId: `delegation-${suffix}`,
        workdir,
      },
    },
  };
}

function toolFrom(toolkit: AgentToolkit, name: string) {
  const definition = toolkit.tools.find(({ tool }) => tool.name === name);
  assert.ok(definition, `missing ${name} tool`);
  return definition.tool;
}

test('static local tools interpret relative inputs against each call\'s workdir', async (t) => {
  const workdirA = mkdtempSync(resolve(tmpdir(), 'pinpawo-shell-root-a-'));
  const workdirB = mkdtempSync(resolve(tmpdir(), 'pinpawo-shell-root-b-'));
  const shellA = new PosixShellRS();
  const shellB = new PosixShellRS();
  t.after(async () => {
    await Promise.all([shellA.dispose(), shellB.dispose()]);
    rmSync(workdirA, { recursive: true, force: true });
    rmSync(workdirB, { recursive: true, force: true });
  });

  // Two Hosts in one process, each with its own ShellRS instance.
  const toolkitA = createBashToolkit({ shell: shellA });
  const toolkitB = createBashToolkit({ shell: shellB });
  const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.cwd())"`;

  assert.equal(
    String(await toolFrom(toolkitA, 'run_shell').invoke({ command }, call(workdirA, 'a'))),
    realpathSync(workdirA),
  );
  assert.equal(
    String(await toolFrom(toolkitB, 'run_shell').invoke({ command }, call(workdirB, 'b'))),
    realpathSync(workdirB),
  );
  await toolFrom(toolkitA, 'write_file').invoke({
    path: 'host-a.txt',
    content: 'host A',
  }, call(workdirA, 'a'));
  assert.equal(readFileSync(resolve(workdirA, 'host-a.txt'), 'utf-8'), 'host A');
  assert.equal(existsSync(resolve(workdirB, 'host-a.txt')), false);

  // The same session may move to another workdir; nothing is bound to the
  // first one.
  assert.equal(
    String(await toolFrom(toolkitA, 'run_shell').invoke({ command }, call(workdirB, 'a'))),
    realpathSync(workdirB),
  );
  // inspect_shell resolves its default cwd the same way.
  assert.equal(
    String(await toolFrom(toolkitA, 'inspect_shell').invoke({ command: 'pwd' }, call(workdirB, 'a'))).trim(),
    realpathSync(workdirB),
  );
});

test('git toolkit defaults repository operations to the call workdir', async (t) => {
  const workdir = mkdtempSync(resolve(tmpdir(), 'pinpawo-git-workdir-'));
  const shell = new PosixShellRS();
  t.after(async () => {
    await shell.dispose();
    rmSync(workdir, { recursive: true, force: true });
  });
  const toolkit = createGitToolkit({ shell });

  const result = String(await toolFrom(toolkit, 'git_status').invoke({}, call(workdir, 'git')));
  assert.match(result, /not a git repository/i);
  assert.doesNotMatch(result, /pinpawo-agent/);
});

test('an invalid path returns a recoverable tool error through the normal path', async (t) => {
  const workdir = mkdtempSync(resolve(tmpdir(), 'pinpawo-empty-path-'));
  const shell = new PosixShellRS();
  t.after(async () => {
    await shell.dispose();
    rmSync(workdir, { recursive: true, force: true });
  });
  const toolkit = createBashToolkit({ shell });

  const result = await toolFrom(toolkit, 'view_file_chunk').invoke({
    name: 'view_file_chunk',
    args: { path: '' },
    id: 'call-empty-path',
    type: 'tool_call',
  }, call(workdir, 'empty'));
  assert.equal(ToolMessage.isInstance(result), true);
  assert.match(String(ToolMessage.isInstance(result) ? result.content : result), /Error/);
});
