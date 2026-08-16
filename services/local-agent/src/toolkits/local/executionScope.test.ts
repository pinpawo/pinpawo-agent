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

async function authorizationMatcher(toolkit: AgentToolkit, toolName: string, input: unknown) {
  const definition = toolkit.tools.find(({ tool }) => tool.name === toolName);
  const buildMatcher = definition?.review?.authorization?.buildMatcher;
  assert.ok(buildMatcher, `missing authorization matcher for ${toolName}`);
  return buildMatcher({
    toolkitName: toolkit.name,
    toolName,
    input,
    operation: definition.operation,
  });
}

test('Host-scoped local toolkits resolve relative paths independently', async (t) => {
  const workdirA = mkdtempSync(resolve(tmpdir(), 'pinpawo-tool-context-a-'));
  const workdirB = mkdtempSync(resolve(tmpdir(), 'pinpawo-tool-context-b-'));
  const outside = mkdtempSync(resolve(tmpdir(), 'pinpawo-tool-context-outside-'));
  t.after(() => {
    rmSync(workdirA, { recursive: true, force: true });
    rmSync(workdirB, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const toolkitA = createBashToolkit({ workdir: workdirA });
  const toolkitB = createBashToolkit({ workdir: workdirB });

  await Promise.all([
    toolFrom(toolkitA, 'write_file').invoke({
      path: 'shared.txt',
      content: 'workspace-a',
    }),
    toolFrom(toolkitB, 'write_file').invoke({
      path: 'shared.txt',
      content: 'workspace-b',
    }),
    toolFrom(toolkitA, 'write_file').invoke({
      path: resolve(outside, 'explicit.txt'),
      content: 'outside-is-allowed',
    }),
  ]);

  assert.equal(readFileSync(resolve(workdirA, 'shared.txt'), 'utf8'), 'workspace-a');
  assert.equal(readFileSync(resolve(workdirB, 'shared.txt'), 'utf8'), 'workspace-b');
  assert.equal(readFileSync(resolve(outside, 'explicit.txt'), 'utf8'), 'outside-is-allowed');

  await toolFrom(toolkitA, 'apply_patch').invoke({
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

  const [listA, listB] = await Promise.all([
    toolFrom(toolkitA, 'list_dir').invoke({ path: '.' }),
    toolFrom(toolkitB, 'list_dir').invoke({ path: '.' }),
  ]);
  assert.match(String(listA), /shared\.txt/);
  assert.match(String(listB), /shared\.txt/);
  assert.doesNotMatch(String(listA), /explicit\.txt/);
  assert.doesNotMatch(String(listB), /explicit\.txt/);
});

test('Host-scoped git toolkits use their workdir and honor an explicit cwd', async (t) => {
  const workdirA = mkdtempSync(resolve(tmpdir(), 'pinpawo-git-context-a-'));
  const workdirB = mkdtempSync(resolve(tmpdir(), 'pinpawo-git-context-b-'));
  t.after(() => {
    rmSync(workdirA, { recursive: true, force: true });
    rmSync(workdirB, { recursive: true, force: true });
  });
  for (const workdir of [workdirA, workdirB]) {
    execFileSync('git', ['init', '--quiet'], { cwd: workdir });
  }
  writeFileSync(resolve(workdirA, 'only-a.txt'), 'a');
  writeFileSync(resolve(workdirB, 'only-b.txt'), 'b');

  const toolkitA = createGitToolkit({ workdir: workdirA });
  const toolkitB = createGitToolkit({ workdir: workdirB });
  assert.equal(toolkitA.runtime, undefined, 'git has no Toolkit-owned runtime resources');
  const [statusA, statusB, explicitBFromA] = await Promise.all([
    toolFrom(toolkitA, 'git_status').invoke({}),
    toolFrom(toolkitB, 'git_status').invoke({}),
    toolFrom(toolkitA, 'git_status').invoke({ cwd: workdirB }),
  ]);

  assert.match(String(statusA), /only-a\.txt/);
  assert.doesNotMatch(String(statusA), /only-b\.txt/);
  assert.match(String(statusB), /only-b\.txt/);
  assert.doesNotMatch(String(statusB), /only-a\.txt/);
  assert.match(String(explicitBFromA), /only-b\.txt/);
  assert.doesNotMatch(String(explicitBFromA), /only-a\.txt/);
});

test('Host workdir participates in reusable local authorization identity', async () => {
  const toolkitA = createBashToolkit({ workdir: '/workspace/a' });
  const toolkitB = createBashToolkit({ workdir: '/workspace/b' });
  const input = { command: 'rm output.tmp' };

  const firstA = await authorizationMatcher(toolkitA, 'run_shell', input);
  const secondA = await authorizationMatcher(toolkitA, 'run_shell', input);
  const firstB = await authorizationMatcher(toolkitB, 'run_shell', input);

  assert.deepEqual(firstA, secondA);
  assert.notDeepEqual(firstA, firstB);
});

test('separate Host managers own independent shell Runtime roots', async (t) => {
  const workdirA = mkdtempSync(resolve(tmpdir(), 'pinpawo-shell-root-a-'));
  const workdirB = mkdtempSync(resolve(tmpdir(), 'pinpawo-shell-root-b-'));
  t.after(() => {
    rmSync(workdirA, { recursive: true, force: true });
    rmSync(workdirB, { recursive: true, force: true });
  });
  const toolkitA = createBashToolkit({ workdir: workdirA });
  const toolkitB = createBashToolkit({ workdir: workdirB });
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
    const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.cwd())"`;
    assert.match(
      String(await toolFrom(firstA.toolkits[0]!, 'run_shell').invoke({ command })),
      new RegExp(basename(workdirA)),
    );
    assert.match(
      String(await toolFrom(firstB.toolkits[0]!, 'run_shell').invoke({ command })),
      new RegExp(basename(workdirB)),
    );
    assert.match(
      String(
        await toolFrom(firstA.toolkits[0]!, 'run_shell').invoke({
          command,
          cwd: workdirB,
        }),
      ),
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
    await Promise.all([firstA?.release(), firstB?.release(), laterB?.release()]);
    await Promise.all([managerA.stop(), managerB.stop()]);
  }
});
