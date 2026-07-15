import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ToolMessage } from '@langchain/core/messages';
import { createBashToolkit, createGitToolkit, loadCoreLocalTools } from './toolkits/local';
import {
  gitAddTool,
  gitCommitTool,
  gitDiffTool,
  ghIssueCommentsTool,
  ghIssueViewTool,
  ghPrDiffTool,
  ghReadContentTool,
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

test('gh issue tools progressively read comments and spill large pages to Markdown', async (t) => {
  const issueUrl = 'https://github.com/pinpawo/pinpawo-agent/issues/377';
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-gh-content-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const fakeGh = createFakeGh(t, `
case "$*" in
  "api repos/pinpawo/pinpawo-agent/issues/377")
    long_body=$(awk 'BEGIN { for (i = 0; i < 59999; i++) printf "x" }')
    printf '{"number":377,"title":"Toolkit issue","state":"open","user":{"login":"octocat"},"labels":[],"assignees":[],"milestone":null,"html_url":"${issueUrl}","body":"%s😀","comments":3}\\n' "$long_body"
    ;;
  "api repos/pinpawo/pinpawo-agent/issues/377/comments?per_page=2&page=1")
    long_comment=$(awk 'BEGIN { for (i = 0; i < 60000; i++) printf "x" }')
    printf '[{"id":1,"user":{"login":"ci-bot"},"body":"%s","created_at":"2026-07-13T00:00:00Z","updated_at":"2026-07-13T00:00:00Z","html_url":"${issueUrl}#issuecomment-1"},{"id":2,"user":{"login":"reviewer"},"body":"%s","created_at":"2026-07-13T01:00:00Z","updated_at":"2026-07-13T01:00:00Z","html_url":"${issueUrl}#issuecomment-2"}]\\n' "$long_comment" "$long_comment"
    ;;
  "api repos/pinpawo/pinpawo-agent/issues/377/comments?per_page=2&page=2")
    printf '[{"id":3,"user":{"login":"reviewer"},"body":"last comment","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","html_url":"${issueUrl}#issuecomment-3"}]\\n'
    ;;
  *)
    printf 'unexpected gh arguments: %s\\n' "$*" >&2
    exit 2
    ;;
esac`);

  const issueOutput = JSON.parse(String(await ghIssueViewTool.invoke({
    issue: issueUrl,
    cwd: workdir,
  }))) as {
    body: string;
    bodyTruncation: { truncated: boolean; originalChars: number; returnedChars: number };
    commentsTotal: number;
    comments?: unknown;
  };
  assert.equal(issueOutput.body, 'x'.repeat(59_999));
  assert.deepEqual(issueOutput.bodyTruncation, {
    truncated: true,
    originalChars: 60_001,
    returnedChars: 59_999,
  });
  assert.equal(issueOutput.commentsTotal, 3);
  assert.equal(issueOutput.comments, undefined);

  const inlineOutput = JSON.parse(String(await ghIssueCommentsTool.invoke({
    issue: issueUrl,
    cwd: workdir,
    page: 2,
    perPage: 2,
  }))) as {
    comments: Array<{ body: string; bodyTruncation: { truncated: boolean } }>;
    commentsPagination: {
      page: number;
      perPage: number;
      returnedCount: number;
      totalCount: number;
      hasPreviousPage: boolean;
      hasNextPage: boolean;
    };
    commentsContent: { delivery: string; truncated: boolean };
  };
  assert.equal(inlineOutput.comments[0]?.body, 'last comment');
  assert.equal(inlineOutput.comments[0]?.bodyTruncation.truncated, false);
  assert.deepEqual(inlineOutput.commentsPagination, {
    page: 2,
    perPage: 2,
    returnedCount: 1,
    totalCount: 3,
    hasPreviousPage: true,
    hasNextPage: false,
  });
  assert.deepEqual(inlineOutput.commentsContent, {
    delivery: 'inline',
    format: 'json',
    chars: JSON.stringify(inlineOutput.comments).length,
    truncated: false,
  });

  const fileOutput = JSON.parse(String(await ghIssueCommentsTool.invoke({
    issue: issueUrl,
    cwd: workdir,
    page: 1,
    perPage: 2,
  }))) as {
    comments: Array<{ body?: string; bodyChars: number }>;
    commentsContent: {
      delivery: string;
      path: string;
      cwd: string;
      truncated: boolean;
      readWith: string;
    };
  };
  assert.equal(fileOutput.commentsContent.delivery, 'file');
  assert.equal(fileOutput.commentsContent.cwd, workdir);
  assert.equal(fileOutput.commentsContent.truncated, false);
  assert.equal(fileOutput.commentsContent.readWith, 'gh_read_content');
  assert.equal(fileOutput.comments[0]?.body, undefined);
  assert.equal(fileOutput.comments[0]?.bodyChars, 60_000);
  assert.equal(existsSync(fileOutput.commentsContent.path), true);
  assert.equal(
    readFileSync(fileOutput.commentsContent.path, 'utf-8').match(/x/g)?.length,
    120_000,
  );
  assert.match(String(await ghReadContentTool.invoke({
    cwd: workdir,
    path: fileOutput.commentsContent.path,
    startLine: 1,
    lineCount: 7,
  })), /1: # pinpawo\/pinpawo-agent issue #377 comments[\s\S]*7: ## Comment 1/);
  await assert.rejects(
    () => ghReadContentTool.invoke({ cwd: workdir, path: join(workdir, 'outside.md') }),
    /only reads files under/,
  );

  writeFileSync(fakeGh, '#!/bin/sh\nprintf \'auth failed\\n\' >&2\nexit 1\n', 'utf-8');
  await assert.rejects(
    () => ghIssueViewTool.invoke({ issue: issueUrl, cwd: workdir }),
    /gh command failed \(exit 1\):\nauth failed/,
  );

  const toolError = await ghIssueViewTool.invoke({
    name: 'gh_issue_view',
    args: { issue: issueUrl, cwd: workdir },
    id: 'call-error',
    type: 'tool_call',
  }, { toolCallId: 'call-error' } as never);
  assert.equal(ToolMessage.isInstance(toolError), true);
  assert.equal(ToolMessage.isInstance(toolError) ? toolError.status : null, 'error');

  writeFileSync(fakeGh, '#!/bin/sh\nexit 0\n', 'utf-8');
  assert.equal(await ghPrDiffTool.invoke({ pr: '123', cwd: workdir }), '(empty diff)');
  await assert.rejects(
    () => ghIssueViewTool.invoke({ issue: issueUrl, cwd: workdir }),
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
      'gh_issue_comments',
      'gh_read_content',
    ],
  );
  assert.equal(toolkit.operations?.git_diff?.title, '查看 git diff');
  assert.equal(toolkit.operations?.git_commit?.title, '创建 git commit');
  assert.equal(toolkit.operations?.gh_pr_view?.title, '查看 GitHub PR');
  assert.equal(toolkit.operations?.gh_pr_diff?.title, '查看 GitHub PR diff');
  assert.equal(toolkit.operations?.gh_issue_comments?.title, '查看 GitHub issue 评论');
  assert.equal(toolkit.operations?.gh_read_content?.title, '读取 GitHub 临时内容');
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
