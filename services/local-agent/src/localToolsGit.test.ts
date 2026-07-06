import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBashToolkit, createGitToolkit, loadCoreLocalTools } from './toolkits/local';
import {
  gitAddTool,
  gitCommitTool,
  gitDiffTool,
  gitStatusTool,
} from './toolkits/local/gitTools';

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
    /requires human review/,
  );
});

test('git_add requires explicit pathspecs', async () => {
  await assert.rejects(
    () => gitAddTool.invoke({ pathspecs: [] }),
    /Too small|at least/,
  );
});

test('createBashToolkit does not own git tools or operation metadata', () => {
  const toolkit = createBashToolkit();
  assert.equal(Array.isArray(toolkit.tools), true);
  const tools = Array.isArray(toolkit.tools) ? toolkit.tools : [];
  assert.equal(tools.some((item) => item.name === 'git_status'), false);
  assert.equal(tools.some((item) => item.name === 'git_commit'), false);
  assert.equal(toolkit.operations?.git_status, undefined);
  assert.equal(toolkit.operations?.git_commit, undefined);
  assert.equal(toolkit.policy?.toolReview?.git_commit, undefined);
});

test('loadCoreLocalTools keeps git tools available for toolkit composition', async () => {
  const tools = await loadCoreLocalTools();

  assert.equal(tools.some((item) => item.name === 'git_status'), true);
  assert.equal(tools.some((item) => item.name === 'git_commit'), true);
});

test('createGitToolkit exposes a dedicated git capability surface', async () => {
  const toolkit = createGitToolkit();
  assert.equal(toolkit.name, 'git');
  assert.equal(Array.isArray(toolkit.tools), true);
  const tools = Array.isArray(toolkit.tools) ? toolkit.tools : [];
  assert.deepEqual(
    tools.map((item) => item.name),
    [
      'git_status',
      'git_diff',
      'git_log',
      'git_branch',
      'git_show',
      'git_add',
      'git_commit',
      'gh_pr_view',
      'gh_pr_diff',
      'gh_issue_view',
    ],
  );
  assert.equal(toolkit.operations?.git_diff?.title, '查看 git diff');
  assert.equal(toolkit.operations?.git_commit?.title, '创建 git commit');
  assert.equal(toolkit.operations?.gh_pr_view?.title, '查看 GitHub PR');
  assert.equal(toolkit.operations?.gh_pr_diff?.title, '查看 GitHub PR diff');
  assert.equal(Boolean(toolkit.policy?.toolReview?.git_add), true);
  assert.equal(Boolean(toolkit.policy?.toolReview?.git_commit), true);

  const review = await toolkit.policy?.toolReview?.git_commit?.request({
    models: {} as never,
    actor: {} as never,
    messages: [],
    toolkitName: 'git',
    toolName: 'git_commit',
    input: { cwd: '/repo', message: 'test: commit' },
    operation: toolkit.operations?.git_commit,
    reviewCapabilities: {
      humanReview: true,
      sessionAuthorization: true,
    },
  });
  assert.deepEqual(
    review && 'schemaVersion' in review ? review.options.map((option) => option.id) : [],
    ['approve', 'approve-and-authorize-thread', 'reject', 'respond'],
  );
});
