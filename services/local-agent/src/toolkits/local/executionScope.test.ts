import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
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

test('git toolkit does not declare a Runtime solely to bind workdir', () => {
  assert.equal(createGitToolkit().runtime, undefined);
});

test('separate Host managers own independent shell Runtime roots', async (t) => {
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
        cwd: workdirA,
      })),
      realpathSync(workdirA),
    );
    assert.equal(
      String(await toolFrom(firstB.toolkits[0]!, 'run_shell').invoke({
        command,
        cwd: workdirB,
      })),
      realpathSync(workdirB),
    );

    await Promise.all([firstA.release(), firstB.release()]);
    await managerA.stop();

    laterB = await managerB.resolve({
      toolkits: [toolkitB],
      execution: executionScope(workdirB, 'b-later'),
    });
    assert.equal(
      String(await toolFrom(laterB.toolkits[0]!, 'run_shell').invoke({
        command,
        cwd: workdirB,
      })),
      realpathSync(workdirB),
    );
  } finally {
    await Promise.all([firstA?.release(), firstB?.release(), laterB?.release()]);
    await Promise.all([managerA.stop(), managerB.stop()]);
  }
});
