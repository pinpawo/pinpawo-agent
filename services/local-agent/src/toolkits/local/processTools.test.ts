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
import { createRunShellTool } from './shellTools';
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

function toolFrom(toolkit: AgentToolkit, name: string) {
  const definition = toolkit.tools.find(({ tool }) => tool.name === name);
  assert.ok(definition, `missing ${name}`);
  return definition.tool;
}

test('run_shell hands a slow command to the background', { skip: isWindows }, async () => {
  const { runShell, shell } = setup();
  const output = String(await runShell.invoke({
    command: 'echo starting; sleep 4',
    timeoutSeconds: 1,
  }, call()));

  assert.match(output, /still running/);
  assert.match(output, /Process id: /);
  assert.match(output, /starting/, 'output so far must be reported');
  assert.match(output, /Do not rerun/, 'must steer the model away from a retry');

  await shell.dispose();
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
  const { runShell, waitTool, shell } = setup();
  const started = String(await runShell.invoke({
    command: 'echo one; sleep 1; echo two; exit 4',
    timeoutSeconds: 1,
  }, call()));
  const processId = processIdFrom(started);

  const finished = String(await waitTool.invoke({ processId, waitSeconds: 5 }, call()));
  assert.match(finished, /exited with code 4/);
  assert.match(finished, /two/, 'output produced after the handover is delivered');
  assert.doesNotMatch(finished, /one/, 'already-delivered output is not repeated');
  await shell.dispose();
});

test('wait_process returns early while the command is still running', { skip: isWindows }, async () => {
  const { runShell, waitTool, shell } = setup();
  const started = String(await runShell.invoke({
    command: 'sleep 6',
    timeoutSeconds: 1,
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
  const { runShell, terminateTool, shell } = setup();
  const marker = `pinpawo-tools-terminate-${Date.now().toString()}`;
  const started = String(await runShell.invoke({
    command: `node -e "process.title='${marker}'; setTimeout(() => {}, 10000)"`,
    timeoutSeconds: 1,
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
  const { runShell, waitTool, listTool, terminateTool, shell } = setup();
  const started = String(await runShell.invoke({
    command: 'echo early; sleep 6',
    timeoutSeconds: 1,
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
  const { runShell, waitTool, listTool, terminateTool, shell } = setup();
  const started = String(await runShell.invoke({
    command: 'sleep 4',
    timeoutSeconds: 1,
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
  const started = String(await toolFrom(bash, 'run_shell').invoke({
    command: 'sleep 4',
    timeoutSeconds: 1,
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
  const started = String(await toolFrom(bash, 'run_shell').invoke({
    command: 'sleep 4',
    timeoutSeconds: 1,
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
