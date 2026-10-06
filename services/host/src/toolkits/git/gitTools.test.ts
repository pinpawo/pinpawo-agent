import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import { PosixShellRS } from '../shellRS';
import type { ShellRS } from '../shellRS/shellRS';
import { createGitToolkit } from './index';
import { createGitTools } from './gitTools';

const sessionContext = {
  executionScope: {
    threadId: 'thread-git', taskId: 'task-1', runId: 'run-1', delegationId: 'delegation-1',
  },
};

/** Tools run through ShellRS on behalf of an Agent session. */
function sessionTool(name: string) {
  const found = createGitTools(new PosixShellRS()).gitTools.find((item) => item.name === name);
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

const gitAddTool = sessionTool('git_add');
const gitCommitTool = sessionTool('git_commit');
const gitDiffTool = sessionTool('git_diff');
const gitPushTool = sessionTool('git_push');
const gitStatusTool = sessionTool('git_status');
const gitShellTool = sessionTool('git_shell');

function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-git-tools-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'PinPawo Test'], { cwd: dir });
  return dir;
}

test('git tools inspect and stage a repository without shell command strings', async () => {
  const repo = createRepo();
  const file = join(repo, 'README.md');
  writeFileSync(file, 'hello\n', 'utf-8');

  assert.match(
    String(await gitStatusTool.invoke({ cwd: repo })),
    /README\.md/,
  );

  assert.match(
    String(await gitAddTool.invoke({ cwd: repo, pathspecs: ['README.md'] })),
    /\(no output\)/,
  );

  assert.match(
    String(await gitDiffTool.invoke({ cwd: repo, staged: true, stat: true })),
    /README\.md/,
  );

  assert.match(
    String(await gitCommitTool.invoke({ cwd: repo, message: 'test: add readme' })),
    /test: add readme/,
  );
});

test('git_add requires explicit pathspecs', async () => {
  await assert.rejects(
    () => gitAddTool.invoke({ pathspecs: [] }),
    /Too small|at least/,
  );
});

test('git_push performs a normal push without exposing force or delete options', async (t) => {
  const repo = createRepo();
  const remote = mkdtempSync(join(tmpdir(), 'pinpawo-git-remote-'));
  const extMarker = join(repo, 'ext-helper-ran');
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  writeFileSync(join(repo, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'test: initial commit'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['init', '--bare'], { cwd: remote, stdio: 'ignore' });
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf-8' }).trim();

  assert.match(
    String(await gitPushTool.invoke({ cwd: repo, remote })),
    /new branch/,
  );
  assert.equal(
    execFileSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: remote, encoding: 'utf-8' }).trim().length,
    40,
  );
  await assert.rejects(
    () => gitPushTool.invoke({ cwd: repo, remote, refspec: '+HEAD:main' }),
    /force and delete refspecs are not supported/,
  );

  assert.match(
    String(await gitPushTool.invoke({
      cwd: repo,
      remote: `ext::touch ${extMarker}`,
    })),
    /transport 'ext' not allowed/,
  );
  assert.equal(existsSync(extMarker), false);

  execFileSync('git', ['remote', 'add', 'unsafe-ext', `ext::touch ${extMarker}`], { cwd: repo });
  assert.match(
    String(await gitPushTool.invoke({ cwd: repo, remote: 'unsafe-ext' })),
    /transport 'ext' not allowed/,
  );
  assert.equal(existsSync(extMarker), false);
});

test('createGitToolkit exposes the local git surface', async () => {
  const toolkit = createGitToolkit({ shell: new PosixShellRS() });
  assert.equal(toolkit.name, 'git');
  assert.deepEqual(
    toolkit.tools.map((item) => item.tool.name),
    ['git_status', 'git_diff', 'git_log', 'git_branch', 'git_show', 'git_add', 'git_commit', 'git_push', 'git_shell'],
  );
  assert.equal(definition(toolkit, 'git_diff')?.operation?.title, '查看 git diff');
  assert.equal(definition(toolkit, 'git_commit')?.operation?.title, '创建 git commit');
  assert.equal(definition(toolkit, 'git_push')?.operation?.title, '推送 git 分支');
  // Dedicated tools exclude dangerous forms by schema and run unreviewed.
  for (const name of ['git_add', 'git_commit', 'git_push']) {
    assert.equal(definition(toolkit, name)?.review, undefined, `${name} runs without review`);
  }

  const gitShellPolicy = definition(toolkit, 'git_shell')?.review;
  assert.ok(gitShellPolicy);
  const reviewContext = {
    toolkitName: 'git',
    toolName: 'git_shell',
    input: { cwd: '/repo', args: ['reset', '--hard', 'HEAD'] },
    operation: definition(toolkit, 'git_shell')?.operation,
    reviewCapabilities: {
      humanReview: true,
      sessionAuthorization: true,
    },
  };
  const buildMatcher = gitShellPolicy.authorization?.buildMatcher;
  assert.ok(buildMatcher);
  const authorizationMatcher = await buildMatcher(reviewContext);
  const review = await gitShellPolicy.request({
    ...reviewContext,
    authorizationMatcher,
  });
  assert.deepEqual(
    review && 'schemaVersion' in review ? review.options.map((option) => option.id) : [],
    ['approve', 'approve-and-authorize-thread', 'reject', 'respond'],
  );
});


test('git_shell reviews only risky calls', async () => {
  const toolkit = createGitToolkit({ shell: new PosixShellRS() });
  const reviewOf = async (args: string[]) => {
    const found = definition(toolkit, 'git_shell');
    assert.ok(found?.review);
    return found.review.request({
      toolkitName: 'git',
      toolName: 'git_shell',
      input: { cwd: '/repo', args },
      operation: found.operation,
      reviewCapabilities: { humanReview: true, sessionAuthorization: true },
    });
  };
  assert.equal(await reviewOf(['log', '--oneline', '-5']), null);
  assert.equal(await reviewOf(['branch', '-a']), null);
  // Everyday writes lean permissive.
  assert.equal(await reviewOf(['commit', '-m', 'wip']), null);
  assert.equal(await reviewOf(['rebase', 'main']), null);
  for (const args of [
    ['reset', '--hard', 'HEAD'],
    ['push', '--force', 'origin', 'HEAD'],
    ['clean', '-fd'],
    ['-c', 'core.pager=sh', 'log'],
  ]) {
    const review = await reviewOf(args);
    assert.ok(review && 'schemaVersion' in review, `git ${args.join(' ')} must be reviewed`);
    assert.equal(review.view.kind === 'plain' ? review.view.title : '', definition(toolkit, 'git_shell')?.operation?.title);
  }
  assert.deepEqual(
    definition(toolkit, 'git_shell')?.operation?.summarizeInput?.({ cwd: '/repo', args: ['commit', '-m', 'a b'] }),
    { target: '/repo', summary: "git commit -m 'a b'", details: { level: 'change' } },
  );
});

test('git_shell runs argv without a shell and fails instead of opening an editor', async () => {
  const repo = createRepo();
  writeFileSync(join(repo, 'a.txt'), 'one\n', 'utf-8');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  writeFileSync(join(repo, 'a.txt'), 'changed\n', 'utf-8');

  assert.match(String(await gitShellTool.invoke({ cwd: repo, args: ['status', '--short'] })), /a\.txt/);
  assert.match(String(await gitShellTool.invoke({ cwd: repo, args: ['log', '--oneline', '|', 'head'] })), /^Error/);
  await gitShellTool.invoke({ cwd: repo, args: ['reset', '--hard', 'HEAD'] });
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf-8'), 'one\n');

  writeFileSync(join(repo, 'b.txt'), 'b\n', 'utf-8');
  execFileSync('git', ['add', 'b.txt'], { cwd: repo });
  const started = Date.now();
  assert.match(String(await gitShellTool.invoke({ cwd: repo, args: ['commit'] })), /^Error/);
  assert.ok(Date.now() - started < 10_000, 'editor-requiring commit must fail fast');

  await assert.rejects(() => gitShellTool.invoke({ cwd: repo, args: ['git', 'status'] }), /args 不包含 git/);
});


test('git ended by a signal reports an error, not an empty success', async () => {
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
  const gitStatus = createGitTools(shell).gitTools.find((item) => item.name === 'git_status')!;
  assert.equal(
    await gitStatus.invoke({} as never, { context: sessionContext }),
    'Error: git status was terminated by a signal',
  );
});
