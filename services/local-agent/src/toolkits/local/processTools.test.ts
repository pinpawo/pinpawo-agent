import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { test } from 'node:test';
import { ProcessRegistry, type ManagedProcessOwner } from './processRegistry';
import {
  createProcessTools,
  LIST_PROCESSES_TOOL_NAME,
  TERMINATE_PROCESS_TOOL_NAME,
  WAIT_PROCESS_TOOL_NAME,
} from './processTools';
import { createRunShellTool } from './shellTools';
import { posixProcessExecutor } from './processTree';
import { ToolkitRuntimeManager } from '@pinpawo/pet-agent';
import { createBashToolkit } from './index';

const OWNER: ManagedProcessOwner = {
  threadId: 'thread-1',
  runId: 'run-1',
  delegationId: 'delegation-1',
};

// End-to-end through the POSIX executor (sh commands, pgrep/pkill probes).
const isWindows = process.platform === 'win32';

function bind() {
  const registry = new ProcessRegistry(posixProcessExecutor);
  const binding = { registry, owner: OWNER };
  const [waitTool, terminateTool, listTool] = createProcessTools(binding);
  return {
    registry,
    binding,
    runShell: createRunShellTool(binding),
    waitTool: waitTool!,
    terminateTool: terminateTool!,
    listTool: listTool!,
  };
}

function processIdFrom(output: string) {
  const match = /Process id: (\S+)/.exec(output);
  assert.ok(match, `expected a process id in:\n${output}`);
  return match[1]!;
}

test('a bound run_shell hands a slow command to the background', { skip: isWindows }, async () => {
  const { runShell, registry } = bind();
  const output = String(await runShell.invoke({
    command: 'echo starting; sleep 4',
    timeoutSeconds: 1,
  }));

  assert.match(output, /still running/);
  assert.match(output, /Process id: /);
  assert.match(output, /starting/, 'output so far must be reported');
  assert.match(output, /Do not rerun/, 'must steer the model away from a retry');

  await registry.stopAll();
});

test('an unbound run_shell still terminates on timeout', { skip: isWindows }, async () => {
  // Without a registry there is nothing to hold the process, so the previous
  // behaviour has to stand.
  const runShell = createRunShellTool(null);
  const output = String(await runShell.invoke({
    command: 'sleep 4',
    timeoutSeconds: 1,
  }));
  assert.match(output, /timed out after 1s/);
  assert.doesNotMatch(output, /Process id/);
});

test('short commands are unaffected by binding', { skip: isWindows }, async () => {
  const { runShell, registry } = bind();
  const output = String(await runShell.invoke({ command: 'echo quick' }));
  assert.match(output, /quick/);
  assert.doesNotMatch(output, /Process id/);
  assert.equal(registry.size, 0, 'a finished command is not registered');
});

test('wait_process reports progress and then the exit code', { skip: isWindows }, async () => {
  const { runShell, waitTool } = bind();
  const started = String(await runShell.invoke({
    command: 'echo one; sleep 1; echo two; exit 4',
    timeoutSeconds: 1,
  }));
  const processId = processIdFrom(started);

  const finished = String(await waitTool.invoke({ processId, waitSeconds: 5 }));
  assert.match(finished, /exited with code 4/);
  assert.match(finished, /two/, 'output produced after the handover is delivered');
  assert.doesNotMatch(finished, /one/, 'already-delivered output is not repeated');
});

test('wait_process returns early while the command is still running', { skip: isWindows }, async () => {
  const { runShell, waitTool, registry } = bind();
  const started = String(await runShell.invoke({
    command: 'sleep 6',
    timeoutSeconds: 1,
  }));
  const processId = processIdFrom(started);

  const begun = Date.now();
  const progress = String(await waitTool.invoke({ processId, waitSeconds: 1 }));
  const elapsed = Date.now() - begun;

  assert.match(progress, /still running/);
  assert.ok(elapsed < 4_000, `must not block for the whole command (${elapsed.toString()}ms)`);

  await registry.stopAll();
});

test('terminate_process stops a background command', { skip: isWindows }, async () => {
  const { runShell, terminateTool } = bind();
  const marker = `pinpawo-tools-terminate-${Date.now().toString()}`;
  const started = String(await runShell.invoke({
    command: `node -e "process.title='${marker}'; setTimeout(() => {}, 10000)"`,
    timeoutSeconds: 1,
  }));
  const processId = processIdFrom(started);

  const result = String(await terminateTool.invoke({ processId }));
  assert.match(result, /terminated/);

  await new Promise((r) => setTimeout(r, 300));
  const alive = execSync(`pgrep -f ${JSON.stringify(marker)} || true`).toString().trim();
  execSync(`pkill -9 -f ${JSON.stringify(marker)} || true`);
  assert.equal(alive, '', 'terminate must reach the process');
});

test('list_processes shows what this execution started', { skip: isWindows }, async () => {
  const { runShell, listTool, registry } = bind();
  assert.match(String(await listTool.invoke({})), /No background processes/);

  await runShell.invoke({ command: 'sleep 4', timeoutSeconds: 1 });
  const listed = String(await listTool.invoke({}));
  assert.match(listed, /still running/);

  await registry.stopAll();
});

test('an unknown process id is reported, not thrown', { skip: isWindows }, async () => {
  const { waitTool, terminateTool } = bind();
  // Tool errors belong in the result so the model can react to them.
  assert.match(
    String(await waitTool.invoke({ processId: 'nope' })),
    /No such process/,
  );
  assert.match(
    String(await terminateTool.invoke({ processId: 'nope' })),
    /No such process/,
  );
});

test('another execution cannot reach a process it did not start', { skip: isWindows }, async () => {
  const { runShell, registry } = bind();
  const started = String(await runShell.invoke({
    command: 'sleep 4',
    timeoutSeconds: 1,
  }));
  const processId = processIdFrom(started);

  const [otherWait] = createProcessTools({
    registry,
    owner: { threadId: 'thread-1', runId: 'run-2', delegationId: 'delegation-2' },
  });
  assert.match(
    String(await otherWait!.invoke({ processId })),
    /different execution/,
  );

  await registry.stopAll();
});

test('the tools report themselves as unavailable without a binding', { skip: isWindows }, async () => {
  const [waitTool, terminateTool, listTool] = createProcessTools(null);
  assert.match(String(await waitTool!.invoke({ processId: 'x' })), /No background processes/);
  assert.match(String(await terminateTool!.invoke({ processId: 'x' })), /No background processes/);
  assert.match(String(await listTool!.invoke({})), /No background processes/);
});

test('the bash toolkit binds through the framework without changing its inventory', { skip: isWindows }, async () => {
  // Exercising the tools directly cannot catch an inventory mismatch: the
  // framework matches bound tools to the static list by position, and rejects
  // the whole toolkit if they disagree.
  const toolkit = createBashToolkit();
  const manager = new ToolkitRuntimeManager();
  await manager.start([toolkit]);

  try {
    const execution = await manager.resolve({
      toolkits: [toolkit],
      execution: {
        threadId: 'thread-1',
        runId: 'run-1',
        delegationId: 'delegation-1',
        workdir: process.cwd(),
      },
    });
    const bound = execution.toolkits.find((item) => item.name === 'bash');
    assert.ok(bound);
    assert.deepEqual(
      bound.tools.map((item) => item.tool.name),
      toolkit.tools.map((item) => item.tool.name),
      'bindTools must return the whole inventory, in order',
    );
    await execution.release();
  } finally {
    await manager.stop();
  }
});

test('the static inventory matches what a binding produces', { skip: isWindows }, () => {
  // bindTools may only swap implementations, never the tool inventory.
  const staticNames = createProcessTools(null).map((item) => item.name);
  const boundNames = createProcessTools({
    registry: new ProcessRegistry(posixProcessExecutor),
    owner: OWNER,
  }).map((item) => item.name);

  assert.deepEqual(staticNames, boundNames);
  assert.deepEqual(staticNames, [
    WAIT_PROCESS_TOOL_NAME,
    TERMINATE_PROCESS_TOOL_NAME,
    LIST_PROCESSES_TOOL_NAME,
  ]);
});
