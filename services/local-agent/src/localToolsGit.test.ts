import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ToolMessage } from '@langchain/core/messages';
import { createBashToolkit, createGitToolkit, loadCoreLocalTools } from './toolkits/local';
import {
  gitAddTool,
  gitCommitTool,
  gitDiffTool,
  ghIssueViewTool,
  gitStatusTool,
} from './toolkits/local/gitTools';

function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-git-tools-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'PinPawo Test'], { cwd: dir });
  return dir;
}

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

test('gh_issue_view paginates comments, reports truncation, and returns error status', async (t) => {
  const issueUrl = 'https://github.com/pinpawo/pinpawo-agent/issues/377';
  const fakeGh = createFakeGh(t, `
case "$*" in
  "api repos/pinpawo/pinpawo-agent/issues/377")
    long_body=$(awk 'BEGIN { for (i = 0; i < 59999; i++) printf "x" }')
    printf '{"number":377,"title":"Toolkit issue","state":"open","user":{"login":"octocat"},"labels":[],"assignees":[],"milestone":null,"html_url":"${issueUrl}","body":"%s😀","comments":3}\\n' "$long_body"
    ;;
  "api repos/pinpawo/pinpawo-agent/issues/377/comments?per_page=2&page=2")
    printf '[{"id":3,"user":{"login":"reviewer"},"body":"last comment","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","html_url":"${issueUrl}#issuecomment-3"}]\\n'
    ;;
  *)
    printf 'unexpected gh arguments: %s\\n' "$*" >&2
    exit 2
    ;;
esac`);

  const output = JSON.parse(String(await ghIssueViewTool.invoke({
    issue: issueUrl,
    cwd: process.cwd(),
    commentsPage: 2,
    commentsPerPage: 2,
  }))) as {
    body: string;
    bodyTruncation: { truncated: boolean; originalChars: number; returnedChars: number };
    comments: Array<{ body: string; bodyTruncation: { truncated: boolean } }>;
    commentsPagination: {
      page: number;
      perPage: number;
      returnedCount: number;
      totalCount: number;
      hasPreviousPage: boolean;
      hasNextPage: boolean;
    };
  };
  assert.equal(output.body, 'x'.repeat(59_999));
  assert.deepEqual(output.bodyTruncation, {
    truncated: true,
    originalChars: 60_001,
    returnedChars: 59_999,
  });
  assert.equal(output.comments[0]?.body, 'last comment');
  assert.equal(output.comments[0]?.bodyTruncation.truncated, false);
  assert.deepEqual(output.commentsPagination, {
    page: 2,
    perPage: 2,
    returnedCount: 1,
    totalCount: 3,
    hasPreviousPage: true,
    hasNextPage: false,
  });

  writeFileSync(fakeGh, '#!/bin/sh\nprintf \'auth failed\\n\' >&2\nexit 1\n', 'utf-8');
  await assert.rejects(
    () => ghIssueViewTool.invoke({ issue: issueUrl, cwd: process.cwd() }),
    /gh command failed \(exit 1\):\nauth failed/,
  );

  const toolError = await ghIssueViewTool.invoke({
    name: 'gh_issue_view',
    args: { issue: issueUrl, cwd: process.cwd() },
    id: 'call-error',
    type: 'tool_call',
  }, { toolCallId: 'call-error' } as never);
  assert.equal(ToolMessage.isInstance(toolError), true);
  assert.equal(ToolMessage.isInstance(toolError) ? toolError.status : null, 'error');

  writeFileSync(fakeGh, '#!/bin/sh\nexit 0\n', 'utf-8');
  await assert.rejects(
    () => ghIssueViewTool.invoke({ issue: issueUrl, cwd: process.cwd() }),
    /gh command returned no output/,
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
