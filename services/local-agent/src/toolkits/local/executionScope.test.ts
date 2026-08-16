import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import test from 'node:test';
import { ToolkitRuntimeManager, type AgentToolkit } from '@pinpawo/pet-agent';
import { createBashToolkit, createGitToolkit } from './index';

function executionScope(workdir: string, suffix: string) {
  return {
    threadId: `thread-${suffix}`,
    runId: `run-${suffix}`,
    delegationId: `delegation-${suffix}`,
    workdir,
  };
}

function toolFrom(toolkit: AgentToolkit, name: string) {
  const definition = toolkit.tools.find(({ tool }) => tool.name === name);
  assert.ok(definition, `missing ${name} tool`);
  return definition.tool;
}

test('bash bindings isolate relative paths across concurrent execution workdirs', async (t) => {
  const workdirA = mkdtempSync(resolve(tmpdir(), 'pinpawo-bash-scope-a-'));
  const workdirB = mkdtempSync(resolve(tmpdir(), 'pinpawo-bash-scope-b-'));
  t.after(() => {
    rmSync(workdirA, { recursive: true, force: true });
    rmSync(workdirB, { recursive: true, force: true });
  });
  const toolkit = createBashToolkit();
  const manager = new ToolkitRuntimeManager();

  const [executionA, executionB] = await Promise.all([
    manager.resolve({ toolkits: [toolkit], execution: executionScope(workdirA, 'a') }),
    manager.resolve({ toolkits: [toolkit], execution: executionScope(workdirB, 'b') }),
  ]);
  t.after(async () => {
    await Promise.all([executionA.release(), executionB.release()]);
    await manager.stop();
  });

  await Promise.all([
    toolFrom(executionA.toolkits[0]!, 'write_file').invoke({
      path: 'shared.txt',
      content: 'workspace-a',
    }),
    toolFrom(executionA.toolkits[0]!, 'write_file').invoke({
      path: 'only-a.txt',
      content: 'a',
    }),
    toolFrom(executionB.toolkits[0]!, 'write_file').invoke({
      path: 'shared.txt',
      content: 'workspace-b',
    }),
    toolFrom(executionB.toolkits[0]!, 'write_file').invoke({
      path: 'only-b.txt',
      content: 'b',
    }),
  ]);

  assert.equal(readFileSync(resolve(workdirA, 'shared.txt'), 'utf8'), 'workspace-a');
  assert.equal(readFileSync(resolve(workdirB, 'shared.txt'), 'utf8'), 'workspace-b');

  await toolFrom(executionA.toolkits[0]!, 'apply_patch').invoke({
    patch: [
      '*** Begin Patch',
      '*** Update File: shared.txt',
      '@@',
      '-workspace-a',
      '+workspace-a-updated',
      '*** End Patch',
    ].join('\n'),
  });
  assert.equal(readFileSync(resolve(workdirA, 'shared.txt'), 'utf8'), 'workspace-a-updated');
  assert.equal(readFileSync(resolve(workdirB, 'shared.txt'), 'utf8'), 'workspace-b');

  const [globA, globB] = await Promise.all([
    toolFrom(executionA.toolkits[0]!, 'glob_search').invoke({ pattern: '*.txt' }),
    toolFrom(executionB.toolkits[0]!, 'glob_search').invoke({ pattern: '*.txt' }),
  ]);
  assert.match(String(globA), /only-a\.txt/);
  assert.doesNotMatch(String(globA), /only-b\.txt/);
  assert.match(String(globB), /only-b\.txt/);
  assert.doesNotMatch(String(globB), /only-a\.txt/);
});

test('git bindings isolate their default repository across execution workdirs', async (t) => {
  const workdirA = mkdtempSync(resolve(tmpdir(), 'pinpawo-git-scope-a-'));
  const workdirB = mkdtempSync(resolve(tmpdir(), 'pinpawo-git-scope-b-'));
  t.after(() => {
    rmSync(workdirA, { recursive: true, force: true });
    rmSync(workdirB, { recursive: true, force: true });
  });
  for (const workdir of [workdirA, workdirB]) {
    execFileSync('git', ['init', '--quiet'], { cwd: workdir });
  }
  writeFileSync(resolve(workdirA, 'only-a.txt'), 'a');
  writeFileSync(resolve(workdirB, 'only-b.txt'), 'b');

  const toolkit = createGitToolkit();
  const manager = new ToolkitRuntimeManager();
  const [executionA, executionB] = await Promise.all([
    manager.resolve({ toolkits: [toolkit], execution: executionScope(workdirA, 'a') }),
    manager.resolve({ toolkits: [toolkit], execution: executionScope(workdirB, 'b') }),
  ]);
  t.after(async () => {
    await Promise.all([executionA.release(), executionB.release()]);
    await manager.stop();
  });

  const [statusA, statusB] = await Promise.all([
    toolFrom(executionA.toolkits[0]!, 'git_status').invoke({}),
    toolFrom(executionB.toolkits[0]!, 'git_status').invoke({}),
  ]);

  assert.match(String(statusA), /only-a\.txt/);
  assert.doesNotMatch(String(statusA), /only-b\.txt/);
  assert.match(String(statusB), /only-b\.txt/);
  assert.doesNotMatch(String(statusB), /only-a\.txt/);
});

test('separate Host managers own independent shell Runtime roots', async (t) => {
  const workdirA = mkdtempSync(resolve(tmpdir(), 'pinpawo-shell-root-a-'));
  const workdirB = mkdtempSync(resolve(tmpdir(), 'pinpawo-shell-root-b-'));
  t.after(() => {
    rmSync(workdirA, { recursive: true, force: true });
    rmSync(workdirB, { recursive: true, force: true });
  });
  const toolkitA = createBashToolkit();
  const toolkitB = createBashToolkit();
  const managerA = new ToolkitRuntimeManager();
  const managerB = new ToolkitRuntimeManager();
  let firstA: Awaited<ReturnType<ToolkitRuntimeManager['resolve']>> | null = null;
  let firstB: Awaited<ReturnType<ToolkitRuntimeManager['resolve']>> | null = null;
  let laterB: Awaited<ReturnType<ToolkitRuntimeManager['resolve']>> | null = null;
  try {
    firstA = await managerA.resolve({
      toolkits: [toolkitA],
      execution: executionScope(workdirA, 'a'),
    });
    firstB = await managerB.resolve({
      toolkits: [toolkitB],
      execution: executionScope(workdirB, 'b'),
    });
    const command = 'node -e "process.stdout.write(process.cwd())"';
    assert.match(
      String(await toolFrom(firstA.toolkits[0]!, 'run_shell').invoke({ command })),
      new RegExp(basename(workdirA)),
    );
    assert.match(
      String(await toolFrom(firstB.toolkits[0]!, 'run_shell').invoke({ command })),
      new RegExp(basename(workdirB)),
    );
    await Promise.all([firstA.release(), firstB.release()]);

    await managerA.stop();
    laterB = await managerB.resolve({
      toolkits: [toolkitB],
      execution: executionScope(workdirB, 'b-later'),
    });
    assert.match(
      String(await toolFrom(laterB.toolkits[0]!, 'run_shell').invoke({ command })),
      new RegExp(basename(workdirB)),
    );
  } finally {
    await Promise.all([
      firstA?.release(),
      firstB?.release(),
      laterB?.release(),
    ]);
    await Promise.all([managerA.stop(), managerB.stop()]);
  }
});
