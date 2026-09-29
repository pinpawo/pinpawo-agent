import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import {
  buildCurrentTimeSnapshot,
  getCurrentTimeTool,
  normalizeShellActionInput,
  normalizeShellAuthorizationInput,
  createRunShellTool,
  shellOperationMetadata,
  truncateShellOutput,
} from './shellTools';
import { createBashToolkit, PosixShellRS } from './index';

const runShellTool = createRunShellTool(new PosixShellRS());
/** A call made within an Agent session, as the Host supplies it. */
const inSession = {
  context: {
    executionScope: {
      threadId: 'thread-shell', taskId: 'task-1', runId: 'run-1', delegationId: 'delegation-1',
    },
  },
};

function definition(toolkit: AgentToolkit, toolName: string) {
  return toolkit.tools.find((item) => item.tool.name === toolName);
}

test('get_current_time returns current time details for a requested timezone', async () => {
  assert.deepEqual(
    buildCurrentTimeSnapshot(new Date('2026-06-23T02:30:00.000Z'), 'Asia/Shanghai'),
    {
      iso: '2026-06-23T02:30:00.000Z',
      timezone: 'Asia/Shanghai',
      localTime: '2026-06-23 10:30:00',
      unixMs: 1782181800000,
      unixSeconds: 1782181800,
    },
  );

  const parsed = JSON.parse(String(await getCurrentTimeTool.invoke({
    timezone: 'Asia/Shanghai',
  }))) as {
    iso?: string;
    timezone?: string;
    localTime?: string;
    unixMs?: number;
    unixSeconds?: number;
  };
  assert.equal(parsed.timezone, 'Asia/Shanghai');
  assert.equal(typeof parsed.iso, 'string');
  assert.equal(typeof parsed.localTime, 'string');
  assert.equal(typeof parsed.unixMs, 'number');
  assert.equal(typeof parsed.unixSeconds, 'number');
});

test('bash toolkit exposes get_current_time without command review', () => {
  const toolkit = createBashToolkit({ shell: new PosixShellRS() });

  assert.equal(Array.isArray(toolkit.tools), true);
  assert.equal(
    Array.isArray(toolkit.tools) && toolkit.tools.some((item) => item.tool.name === 'get_current_time'),
    true,
  );
  assert.ok(definition(toolkit, 'get_current_time')?.operation);
  assert.equal(definition(toolkit, 'get_current_time')?.review, undefined);
});

test('shell review policy reviews configured command execution', async () => {
  const toolkit = createBashToolkit({ shell: new PosixShellRS() });
  const policy = definition(toolkit, 'run_shell')?.review;
  assert.ok(policy);

  const context = {
    toolkitName: 'bash',
    toolName: 'run_shell',
    input: { command: 'pwd' },
    operation: definition(toolkit, 'run_shell')?.operation,
    reviewCapabilities: {
      humanReview: true,
      sessionAuthorization: true,
    },
  };
  const buildMatcher = policy.authorization?.buildMatcher;
  assert.ok(buildMatcher);
  const review = await policy.request({
    ...context,
    authorizationMatcher: await buildMatcher(context),
  });
  assert.equal(review && 'schemaVersion' in review ? review.view.title : null, '执行命令');
  assert.deepEqual(
    review && 'schemaVersion' in review ? review.options.map((option) => option.id) : [],
    ['approve', 'approve-and-authorize-thread', 'reject', 'respond'],
  );
});

test('normalizeShellActionInput preserves explicit cwd and inherits process cwd', () => {
  assert.deepEqual(
    normalizeShellActionInput({ command: ' printf ok ', cwd: '~' }),
    {
      command: 'printf ok',
      cwd: '~',
    },
  );
  assert.deepEqual(
    normalizeShellActionInput({ command: 'pwd', cwd: 'packages/pet-agent' }),
    {
      command: 'pwd',
      cwd: 'packages/pet-agent',
    },
  );
  assert.deepEqual(
    normalizeShellActionInput({ command: 'pwd' }),
    {
      command: 'pwd',
      cwd: process.cwd(),
    },
  );
});

test('normalizeShellAuthorizationInput preserves only model-provided cwd', () => {
  assert.deepEqual(
    normalizeShellAuthorizationInput({ command: ' printf ok ', cwd: ' packages/pet-agent ' }),
    {
      command: 'printf ok',
      cwd: 'packages/pet-agent',
    },
  );
  assert.deepEqual(
    normalizeShellAuthorizationInput({ command: 'pwd' }),
    {
      command: 'pwd',
      cwd: null,
    },
  );
});

test('shell operation metadata preserves the model-provided cwd without classifying command text', () => {
  assert.deepEqual(
    shellOperationMetadata.run_shell?.summarizeInput?.({
      command: "printf 'value' > output.txt",
      cwd: '~',
    }),
    {
      target: '~',
      summary: "printf 'value' > output.txt",
    },
  );
  assert.equal(
    shellOperationMetadata.run_shell?.summarizeInput?.({ command: 'pwd' })?.target,
    undefined,
  );
});

test('runShellTool executes commands and explicit output writes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-shell-write-'));
  const file = join(dir, 'output.txt');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(
    await runShellTool.invoke({ command: 'printf ok' }, inSession),
    'ok',
  );
  assert.equal(await runShellTool.invoke({ command: `printf written > ${file}` }, inSession), '(no output)');
  assert.equal(readFileSync(file, 'utf-8'), 'written');
  assert.equal(await runShellTool.invoke({ command: `printf piped | cat > ${file}` }, inSession), '(no output)');
  assert.equal(readFileSync(file, 'utf-8'), 'piped');
});

test('runShellTool relies on toolkit review instead of a second interface gate', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-shell-review-'));
  const file = join(dir, 'generated.tmp');
  writeFileSync(file, 'generated', 'utf-8');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(await runShellTool.invoke({ command: `rm ${file}` }, inSession), '(no output)');
  assert.equal(existsSync(file), false);
});

test('runShellTool separates stderr and reports exit codes', async () => {
  assert.equal(
    await runShellTool.invoke({ command: 'printf out; printf err 1>&2' }, inSession),
    'out\n--- stderr ---\nerr',
  );

  assert.match(
    String(await runShellTool.invoke({ command: 'printf boom 1>&2; exit 3' }, inSession)),
    /^Error \(exit 3\):\nboom/,
  );
});

test('runShellTool truncates stdout larger than the old 64KB buffer limit', async () => {
  const output = String(await runShellTool.invoke({
    command: 'node -e "process.stdout.write(\'x\'.repeat(70 * 1024))"',
  }, inSession));

  assert.doesNotMatch(output, /ENOBUFS/);
  assert.match(output, /^x+/);
  assert.match(output, /\[\.\.\. truncated \d+ chars \.\.\.\]/);
});

test('a short-command timeout preserves prior side effects without retrying', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-short-timeout-'));
  const shell = new PosixShellRS();
  t.after(async () => {
    await shell.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const result = JSON.parse(String(await createRunShellTool(shell).invoke({
    command: 'printf once >> effects; sleep 5', cwd: dir, timeoutSeconds: 1,
  }, inSession)));
  assert.equal(result.status, 'timeout');
  assert.equal(result.termination, 'confirmed');
  assert.equal(readFileSync(join(dir, 'effects'), 'utf8'), 'once');
  assert.deepEqual(await shell.list('thread-shell'), []);
});

test('truncateShellOutput keeps head and tail with a marker', () => {
  const long = 'a'.repeat(50) + 'b'.repeat(50);
  const truncated = truncateShellOutput(long, 40);
  assert.match(truncated, /^a+\n\[\.\.\. truncated 60 chars \.\.\.\]\nb+$/);
  assert.equal(truncateShellOutput('short', 40), 'short');
});

test('start_process is reviewed with the original command and cwd', async () => {
  const toolkit = createBashToolkit({ shell: new PosixShellRS() });
  const item = definition(toolkit, 'start_process');
  assert.ok(item?.review);
  assert.ok(item.operation);
  assert.deepEqual(item.operation.summarizeInput?.({ command: ' npm test ', cwd: ' relative ' }), {
    target: 'relative', summary: 'npm test',
  });
  const context = {
    toolkitName: 'bash', toolName: 'start_process',
    input: { command: 'npm test', cwd: 'relative' },
    operation: item.operation,
    reviewCapabilities: { humanReview: true, sessionAuthorization: true },
  };
  const buildMatcher = item.review.authorization?.buildMatcher;
  assert.ok(buildMatcher);
  const review = await item.review.request({ ...context, authorizationMatcher: await buildMatcher(context) });
  assert.deepEqual(review && 'schemaVersion' in review ? review.options.map((option) => option.id) : [],
    ['approve', 'approve-and-authorize-thread', 'reject', 'respond']);
  for (const name of ['wait_process', 'list_processes', 'terminate_process']) {
    assert.equal(definition(toolkit, name)?.review, undefined);
  }
});

test('shell tools keep connection uncertainty distinct from timeout', async () => {
  const { ShellRSError } = await import('./shellRS');
  const { createStartProcessTool } = await import('./shellTools');
  const shell = new PosixShellRS();
  shell.exec = async () => { throw new ShellRSError('result_unknown', 'connection lost'); };
  const outputs = await Promise.all([
    createRunShellTool(shell).invoke({ command: 'true' }, inSession),
    createStartProcessTool(shell).invoke({ command: 'true' }, inSession),
  ]);
  for (const output of outputs) {
    const result = JSON.parse(String(output));
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'result_unknown');
    assert.equal(result.termination, undefined);
  }
});

test('inspect_shell remains bounded and does not turn timeouts into background work', async () => {
  const { createInspectShellTool } = await import('./shellTools');
  const shell = new PosixShellRS();
  let calls = 0;
  shell.exec = async (_session, request) => {
    calls += 1;
    assert.equal(request.onTimeout, 'terminate');
    assert.equal(request.waitMs, 1_000);
    return { status: 'timeout', termination: 'unconfirmed', stdout: 'partial', stderr: '' };
  };
  const tool = createInspectShellTool(shell);
  const result = JSON.parse(String(await tool.invoke({ command: 'ls', timeoutSeconds: 1 }, inSession)));
  assert.equal(result.status, 'timeout');
  assert.equal(result.termination, 'unconfirmed');
  assert.equal(result.stdout, 'partial');
  await tool.invoke({ command: 'npm install' }, inSession);
  assert.equal(calls, 1, 'read-only admission still blocks mutation');
});
