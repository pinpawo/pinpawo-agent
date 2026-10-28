import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import { PosixShellRS } from '../shellRS';
import type { ShellRS } from '../shellRS/shellRS';
import { createGithubToolkit } from './index';
import { createGithubTools } from './githubTools';

const sessionContext = {
  executionScope: {
    threadId: 'thread-git', taskId: 'task-1', runId: 'run-1', delegationId: 'delegation-1',
  },
};

/** Tools run through ShellRS on behalf of an Agent session. */
function sessionTool(name: string) {
  const found = createGithubTools(new PosixShellRS()).githubTools.find((item) => item.name === name);
  assert.ok(found, `missing ${name}`);
  return {
    invoke: (input: Record<string, unknown>, config: Record<string, unknown> = {}) => found.invoke(
      input as never,
      { ...config, context: sessionContext },
    ),
  };
}

function definition(toolkit: AgentToolkit, toolName: string) {
  return toolkit.tools.find((item) => item.tool.name === toolName);
}

const ghIssueCreateTool = sessionTool('gh_issue_create');
const ghPrCreateTool = sessionTool('gh_pr_create');

function createFakeGh(t: TestContext, script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-gh-tool-'));
  const executable = join(dir, 'gh');
  const originalPath = process.env.PATH;
  writeFileSync(executable, `#!/bin/sh\n${script}\n`, 'utf-8');
  chmodSync(executable, 0o755);
  process.env.PATH = `${dir}:${originalPath ?? ''}`;
  t.after(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return executable;
}


test('GitHub create tools pass structured arguments to gh without a shell', async (t) => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-gh-create-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  createFakeGh(t, `
case "$*" in
  "pr create --title Fix --body Details --base main --head codex/fix --repo pinpawo/pinpawo-agent --draft")
    printf 'https://github.com/pinpawo/pinpawo-agent/pull/12\\n'
    ;;
  "issue create --title Bug --body Reproduction --repo pinpawo/pinpawo-agent")
    printf 'https://github.com/pinpawo/pinpawo-agent/issues/34\\n'
    ;;
  *)
    printf 'unexpected gh arguments: %s\\n' "$*" >&2
    exit 2
    ;;
esac`);

  assert.equal(
    await ghPrCreateTool.invoke({
      cwd: workdir,
      title: 'Fix',
      body: 'Details',
      base: 'main',
      head: 'codex/fix',
      repository: 'pinpawo/pinpawo-agent',
      draft: true,
    }),
    'https://github.com/pinpawo/pinpawo-agent/pull/12',
  );
  assert.equal(
    await ghIssueCreateTool.invoke({
      cwd: workdir,
      title: 'Bug',
      body: 'Reproduction',
      repository: 'pinpawo/pinpawo-agent',
    }),
    'https://github.com/pinpawo/pinpawo-agent/issues/34',
  );
});

test('gh create tools run with prompts disabled', async (t) => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-gh-env-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  createFakeGh(t, 'printf "%s|%s\\n" "$1 $2" "$GH_PROMPT_DISABLED"');
  assert.equal(await ghIssueCreateTool.invoke({ cwd: workdir, title: 'Bug' }), 'issue create|1');
});

test('createGithubToolkit exposes only the structured create tools', () => {
  const toolkit = createGithubToolkit({ shell: new PosixShellRS() });
  assert.equal(toolkit.name, 'github');
  assert.deepEqual(toolkit.tools.map((item) => item.tool.name), ['gh_pr_create', 'gh_issue_create']);
  assert.equal(definition(toolkit, 'gh_pr_create')?.operation?.title, '创建 GitHub PR');
  assert.equal(definition(toolkit, 'gh_issue_create')?.operation?.title, '创建 GitHub issue');
  for (const name of ['gh_pr_create', 'gh_issue_create']) {
    assert.equal(definition(toolkit, name)?.review, undefined, `${name} runs without review`);
  }
});

test('gh ended by a signal reports an error, not an empty success', async () => {
  // ShellRS reports a signal-terminated process as exited with no code.
  const shell: ShellRS = {
    contract: 'pinpawo.shell-rs',
    version: 1,
    status: () => ({ available: true }),
    ensureSession: () => undefined,
    exec: async () => ({ status: 'exited', code: null, stdout: '', stderr: '' }),
    wait: async () => { throw new Error('unused'); },
    read: async () => { throw new Error('unused'); },
    terminate: async () => { throw new Error('unused'); },
    list: async () => [],
  };
  const ghPrCreate = createGithubTools(shell).githubTools.find((item) => item.name === 'gh_pr_create')!;
  await assert.rejects(
    () => ghPrCreate.invoke({ title: 'x' } as never, { context: sessionContext }),
    /gh command failed: terminated by a signal/,
  );
});
