import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBashToolkit, createGitToolkit, loadLocalPluginTools } from './plugins/localTools';
import {
  gitAddTool,
  gitCommitTool,
  gitDiffTool,
  gitStatusTool,
} from './plugins/localTools/gitTools';

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

test('loadLocalPluginTools keeps git tools available for legacy direct tool paths', async () => {
  const tools = await loadLocalPluginTools();

  assert.equal(tools.some((item) => item.name === 'git_status'), true);
  assert.equal(tools.some((item) => item.name === 'git_commit'), true);
});

test('createGitToolkit exposes a dedicated git capability surface', () => {
  const toolkit = createGitToolkit();
  assert.equal(toolkit.name, 'git');
  assert.equal(Array.isArray(toolkit.tools), true);
  const tools = Array.isArray(toolkit.tools) ? toolkit.tools : [];
  assert.deepEqual(
    tools.map((item) => item.name),
    ['git_status', 'git_diff', 'git_log', 'git_branch', 'git_show', 'git_add', 'git_commit'],
  );
  assert.equal(toolkit.operations?.git_diff?.kind, 'git.diff');
  assert.equal(toolkit.operations?.git_commit?.kind, 'git.commit');
  assert.equal(Boolean(toolkit.policy?.toolReview?.git_commit), true);
});
