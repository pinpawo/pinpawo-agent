import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { ToolkitRuntimeManager, type AgentToolkit } from '@pinpawo/pet-agent';
import { createBashToolkit } from './index';
import { createGitToolkit } from '../git';

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

test('separate Host managers bind local tools to independent execution workdirs', async (t) => {
  const workdirA = mkdtempSync(resolve(tmpdir(), 'pinpawo-shell-root-a-'));
  const workdirB = mkdtempSync(resolve(tmpdir(), 'pinpawo-shell-root-b-'));
  t.after(() => {
    rmSync(workdirA, { recursive: true, force: true });
    rmSync(workdirB, { recursive: true, force: true });
  });

  const managerA = new ToolkitRuntimeManager();
  const managerB = new ToolkitRuntimeManager();
  const toolkitA = createBashToolkit();
  const toolkitB = createBashToolkit();
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
    assert.equal(
      String(await toolFrom(firstA.toolkits[0]!, 'run_shell').invoke({
        command,
      })),
      realpathSync(workdirA),
    );
    assert.equal(
      String(await toolFrom(firstB.toolkits[0]!, 'run_shell').invoke({
        command,
      })),
      realpathSync(workdirB),
    );
    await toolFrom(firstA.toolkits[0]!, 'write_file').invoke({
      path: 'host-a.txt',
      content: 'host A',
    });
    assert.equal(readFileSync(resolve(workdirA, 'host-a.txt'), 'utf-8'), 'host A');
    assert.equal(existsSync(resolve(workdirB, 'host-a.txt')), false);

    await Promise.all([firstA.release(), firstB.release()]);
    await managerA.stop();

    laterB = await managerB.resolve({
      toolkits: [toolkitB],
      execution: executionScope(workdirB, 'b-later'),
    });
    assert.equal(
      String(await toolFrom(laterB.toolkits[0]!, 'run_shell').invoke({
        command,
      })),
      realpathSync(workdirB),
    );
  } finally {
    await Promise.all([firstA?.release(), firstB?.release(), laterB?.release()]);
    await Promise.all([managerA.stop(), managerB.stop()]);
  }
});

test('git toolkit defaults repository operations to the execution workdir', async (t) => {
  const workdir = mkdtempSync(resolve(tmpdir(), 'pinpawo-git-workdir-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const manager = new ToolkitRuntimeManager();
  const toolkit = createGitToolkit();
  let execution: Awaited<ReturnType<ToolkitRuntimeManager['resolve']>> | null = null;

  try {
    execution = await manager.resolve({
      toolkits: [toolkit],
      execution: executionScope(workdir, 'git'),
    });
    const result = String(await toolFrom(execution.toolkits[0]!, 'git_status').invoke({}));
    assert.match(result, /not a git repository/i);
    assert.doesNotMatch(result, /pinpawo-agent/);
  } finally {
    await execution?.release();
    await manager.stop();
  }
});
