import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { test } from 'node:test';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import {
  createProcessTools,
  LIST_PROCESSES_TOOL_NAME,
  TERMINATE_PROCESS_TOOL_NAME,
  WAIT_PROCESS_TOOL_NAME,
} from './processTools';
import { createRunShellTool, createStartProcessTool } from './shellTools';
import { createBashToolkit, createGitToolkit, PosixShellRS } from './index';

// End-to-end through the POSIX executor (sh commands, pgrep/pkill probes).
const isWindows = process.platform === 'win32';

/** Invocation config for one call of one execution of an Agent session. */
function call(threadId = 'thread-1', runId = 'run-1', delegationId = 'delegation-1') {
  return {
    context: {
      executionScope: {
        threadId,
        taskId: 'task-1',
        runId,
        delegationId,
        workdir: process.cwd(),
      },
    },
  };
}

function setup(shell = new PosixShellRS()) {
  const [waitTool, terminateTool, listTool] = createProcessTools(shell);
  return {
    shell,
    runShell: createRunShellTool(shell),
    startProcess: createStartProcessTool(shell),
    waitTool: waitTool!,
    terminateTool: terminateTool!,
    listTool: listTool!,
  };
}

function processIdFrom(output: string) {
  const result = JSON.parse(output);
  assert.equal(result.status, 'started');
  assert.equal(typeof result.processId, 'string');
  return result.processId as string;
}

function toolFrom(toolkit: AgentToolkit, name: string) {
  const definition = toolkit.tools.find(({ tool }) => tool.name === name);
  assert.ok(definition, `missing ${name}`);
  return definition.tool;
}

test('run_shell times out without creating a background process', { skip: isWindows }, async (t) => {
  const { runShell, shell } = setup();
  t.after(() => shell.dispose());
  const result = JSON.parse(String(await runShell.invoke({
    command: 'echo starting; sleep 4', timeoutSeconds: 1,
  }, call())));
  assert.equal(result.status, 'timeout');
  assert.equal(result.termination, 'confirmed');
  assert.equal(result.stdout, 'starting');
  assert.deepEqual(await shell.list('thread-1'), []);
});

test('start_process immediately returns a managed handle', { skip: isWindows }, async (t) => {
  const { startProcess, shell } = setup();
  t.after(() => shell.dispose());
  const processId = processIdFrom(String(await startProcess.invoke({ command: 'sleep 30' }, call())));
  assert.equal((await shell.list('thread-1'))[0]?.processId, processId);
  assert.equal((await shell.list('thread-1'))[0]?.status, 'running');
});

test('start_process preserves fast task output and exit status under a handle', { skip: isWindows }, async (t) => {
  const { startProcess, shell } = setup();
  t.after(() => shell.dispose());
  const started = JSON.parse(String(await startProcess.invoke({ command: 'printf quick; exit 7' }, call())));
  const processId = processIdFrom(JSON.stringify(started));
  const result = await shell.wait('thread-1', processId, 5_000);
  assert.equal(result.process.status, 'exited');
  assert.equal(result.process.exitCode, 7);
  assert.equal(started.stdout + result.stdout, 'quick');
});

test('start_process reports spawn failure without a success handle', { skip: isWindows }, async (t) => {
  const { startProcess, shell } = setup();
  t.after(() => shell.dispose());
  const result = JSON.parse(String(await startProcess.invoke({
    command: 'true', cwd: '/definitely/not/a/directory',
  }, call())));
  assert.equal(result.status, 'spawn_failed');
  assert.equal(result.processId, undefined);
  assert.deepEqual(await shell.list('thread-1'), []);
});

test('run_shell outside an Agent session is an ordinary tool error', { skip: isWindows }, async () => {
  const { runShell, listTool, shell } = setup();
  assert.match(String(await runShell.invoke({ command: 'echo hi' })), /requires an Agent session/);
  assert.match(String(await listTool.invoke({})), /requires an Agent session/);
  await shell.dispose();
});

test('short commands are not held as processes', { skip: isWindows }, async () => {
  const { runShell, shell } = setup();
  const output = String(await runShell.invoke({ command: 'echo quick' }, call()));
  assert.match(output, /quick/);
  assert.doesNotMatch(output, /Process id/);
  assert.deepEqual(await shell.list('thread-1'), [], 'a finished command is not held');
  await shell.dispose();
});

test('wait_process reports progress and then the exit code', { skip: isWindows }, async () => {
  const { startProcess, waitTool, shell } = setup();
  const started = String(await startProcess.invoke({
    command: 'echo one; sleep 1; echo two; exit 4',
  }, call()));
  const processId = processIdFrom(started);

  const finished = String(await waitTool.invoke({ processId, waitSeconds: 5 }, call()));
  assert.match(finished, /exited with code 4/);
  assert.match(finished, /two/, 'output produced after the handover is delivered');
  assert.equal((await shell.read('thread-1', processId)).stdout, '', 'delivered output is not repeated');
  await shell.dispose();
});

test('wait_process returns early while the command is still running', { skip: isWindows }, async () => {
  const { startProcess, waitTool, shell } = setup();
  const started = String(await startProcess.invoke({
    command: 'sleep 6',
  }, call()));
  const processId = processIdFrom(started);

  const begun = Date.now();
  const progress = String(await waitTool.invoke({ processId, waitSeconds: 1 }, call()));
  const elapsed = Date.now() - begun;

  assert.match(progress, /still running/);
  assert.ok(elapsed < 4_000, `must not block for the whole command (${elapsed.toString()}ms)`);

  await shell.dispose();
});

test('terminate_process stops a background command', { skip: isWindows }, async () => {
  const { startProcess, terminateTool, shell } = setup();
  const marker = `pinpawo-tools-terminate-${Date.now().toString()}`;
  const started = String(await startProcess.invoke({
    command: `node -e "process.title='${marker}'; setTimeout(() => {}, 10000)"`,
  }, call()));
  const processId = processIdFrom(started);

  const result = String(await terminateTool.invoke({ processId }, call()));
  assert.match(result, /terminated/);

  await new Promise((r) => setTimeout(r, 300));
  const alive = execSync(`pgrep -f ${JSON.stringify(marker)} || true`).toString().trim();
  assert.equal(alive, '', 'terminate must reach the process');
  await shell.dispose();
});

test('an unknown process id is reported, not thrown', { skip: isWindows }, async () => {
  const { waitTool, terminateTool, shell } = setup();
  // Tool errors belong in the result so the model can react to them.
  assert.match(
    String(await waitTool.invoke({ processId: 'nope' }, call())),
    /No such process/,
  );
  assert.match(
    String(await terminateTool.invoke({ processId: 'nope' }, call())),
    /No such process/,
  );
  await shell.dispose();
});

test('later runs and other delegations of the same session reach its processes', { skip: isWindows }, async () => {
  const { startProcess, waitTool, listTool, terminateTool, shell } = setup();
  const started = String(await startProcess.invoke({
    command: 'echo early; sleep 6',
  }, call('thread-1', 'run-1', 'delegation-1')));
  const processId = processIdFrom(started);

  const laterRun = call('thread-1', 'run-2', 'delegation-9');
  const otherDelegation = call('thread-1', 'run-1', 'delegation-2');
  assert.match(String(await listTool.invoke({}, laterRun)), new RegExp(processId));
  assert.match(String(await listTool.invoke({}, otherDelegation)), new RegExp(processId));
  assert.match(
    String(await waitTool.invoke({ processId, waitSeconds: 1 }, otherDelegation)),
    /still running/,
  );
  assert.match(String(await terminateTool.invoke({ processId }, laterRun)), /terminated/);
  await shell.dispose();
});

test('another session cannot reach or list a process it did not start', { skip: isWindows }, async () => {
  const { startProcess, waitTool, listTool, terminateTool, shell } = setup();
  const started = String(await startProcess.invoke({
    command: 'sleep 4',
  }, call('thread-1')));
  const processId = processIdFrom(started);

  const otherSession = call('thread-2');
  assert.match(String(await waitTool.invoke({ processId }, otherSession)), /different session/);
  assert.match(String(await terminateTool.invoke({ processId }, otherSession)), /different session/);
  assert.match(String(await listTool.invoke({}, otherSession)), /No background processes/);

  await shell.dispose();
});

test('Bash and Git sharing one ShellRS share one logical session per Agent session', { skip: isWindows }, async () => {
  const shell = new PosixShellRS();
  const bash = createBashToolkit({ shell });
  const git = createGitToolkit({ shell });
  const started = String(await toolFrom(bash, 'start_process').invoke({
    command: 'sleep 4',
  }, call('thread-shared')));
  const processId = processIdFrom(started);

  // Git's CLI invocations go through the same instance; they add no held
  // processes and do not disturb Bash's handle.
  await toolFrom(git, 'git_status').invoke({}, call('thread-shared'));
  const listed = await shell.list('thread-shared');
  assert.deepEqual(listed.map((item) => item.processId), [processId]);
  assert.match(
    String(await toolFrom(bash, 'list_processes').invoke({}, call('thread-shared', 'run-2'))),
    new RegExp(processId),
  );
  await shell.dispose();
});

test('Bash and Git on separate ShellRS instances are isolated', { skip: isWindows }, async () => {
  const bashShell = new PosixShellRS();
  const gitShell = new PosixShellRS();
  const bash = createBashToolkit({ shell: bashShell });
  const git = createGitToolkit({ shell: gitShell });
  const started = String(await toolFrom(bash, 'start_process').invoke({
    command: 'sleep 4',
  }, call('thread-split')));
  processIdFrom(started);

  assert.match(String(await toolFrom(git, 'git_status').invoke({}, call('thread-split'))), /\S/);
  assert.equal((await bashShell.list('thread-split')).length, 1);
  assert.equal((await gitShell.list('thread-split')).length, 0);

  // Disposing one instance leaves the other usable.
  await gitShell.dispose();
  assert.equal(gitShell.status().available, false);
  assert.equal(bashShell.status().available, true);
  await bashShell.dispose();
});

test('the process tool inventory is static', () => {
  assert.deepEqual(createProcessTools(new PosixShellRS()).map((item) => item.name), [
    WAIT_PROCESS_TOOL_NAME,
    TERMINATE_PROCESS_TOOL_NAME,
    LIST_PROCESSES_TOOL_NAME,
  ]);
});
