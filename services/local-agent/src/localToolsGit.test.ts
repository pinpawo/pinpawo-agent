import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ToolMessage } from '@langchain/core/messages';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import { createBashToolkit, createGitToolkit, loadCoreLocalTools } from './toolkits/local';
import {
  gitAddTool,
  gitCommitTool,
  gitDiffTool,
  gitPushTool,
  ghIssueCreateTool,
  ghIssueCommentsTool,
  ghIssueViewTool,
  ghPrCreateTool,
  ghPrDiffTool,
  ghReadContentTool,
  gitStatusTool,
} from './toolkits/local/gitTools';

function definition(toolkit: AgentToolkit, toolName: string) {
  return toolkit.tools.find((item) => item.tool.name === toolName);
}

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
  assert.match(
    fileOutput.commentsContent.path,
    /comments-page-1-per-page-2-[0-9a-f]{12}\.md$/,
  );
  assert.equal(
    readFileSync(fileOutput.commentsContent.path, 'utf-8').match(/x/g)?.length,
    120_000,
  );
  const firstChunk = JSON.parse(String(await ghReadContentTool.invoke({
    cwd: workdir,
    path: fileOutput.commentsContent.path,
    startLine: 1,
    lineCount: 7,
  }))) as {
    content: string;
    startLine: number;
    endLine: number;
    nextStartLine: number | null;
    hasMore: boolean;
    returnedChars: number;
  };
  assert.match(firstChunk.content, /1: # pinpawo\/pinpawo-agent issue #377 comments[\s\S]*7: ## Comment 1/);
  assert.equal(firstChunk.startLine, 1);
  assert.equal(firstChunk.endLine, 7);
  assert.equal(firstChunk.nextStartLine, 8);
  assert.equal(firstChunk.hasMore, true);

  const budgetedChunk = JSON.parse(String(await ghReadContentTool.invoke({
    cwd: workdir,
    path: fileOutput.commentsContent.path,
    startLine: 1,
    lineCount: 200,
  }))) as {
    content: string;
    endLine: number;
    nextStartLine: number | null;
    totalLines: number;
    hasMore: boolean;
    returnedChars: number;
  };
  assert.equal(budgetedChunk.returnedChars, budgetedChunk.content.length);
  assert.equal(budgetedChunk.returnedChars <= 60_000, true);
  assert.equal(budgetedChunk.hasMore, true);
  assert.equal(budgetedChunk.endLine < budgetedChunk.totalLines, true);
  assert.equal(budgetedChunk.nextStartLine, budgetedChunk.endLine + 1);
  await assert.rejects(
    () => ghReadContentTool.invoke({
      cwd: workdir,
      path: fileOutput.commentsContent.path,
      lineCount: 201,
    }),
    /Too big|less than or equal to 200/,
  );
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
  assert.equal(tools.some((item) => item.tool.name === 'git_status'), false);
  assert.equal(tools.some((item) => item.tool.name === 'git_commit'), false);
  assert.equal(definition(toolkit, 'git_status'), undefined);
  assert.equal(definition(toolkit, 'git_commit'), undefined);
});

test('loadCoreLocalTools keeps git tools available for toolkit composition', async () => {
  const tools = await loadCoreLocalTools();

  assert.equal(tools.some((item) => item.name === 'git_status'), true);
  assert.equal(tools.some((item) => item.name === 'git_commit'), true);
  assert.equal(tools.some((item) => item.name === 'git_push'), true);
  assert.equal(tools.some((item) => item.name === 'gh_pr_create'), true);
  assert.equal(tools.some((item) => item.name === 'gh_issue_create'), true);
});

test('createGitToolkit exposes a dedicated git capability surface', async () => {
  const toolkit = createGitToolkit();
  assert.equal(toolkit.name, 'git');
  assert.equal(Array.isArray(toolkit.tools), true);
  const tools = Array.isArray(toolkit.tools) ? toolkit.tools : [];
  assert.deepEqual(
    tools.map((item) => item.tool.name),
    [
      'git_status',
      'git_diff',
      'git_log',
      'git_branch',
      'git_show',
      'git_add',
      'git_commit',
      'git_push',
      'gh_pr_create',
      'gh_pr_view',
      'gh_pr_diff',
      'gh_issue_create',
      'gh_issue_view',
      'gh_issue_comments',
      'gh_read_content',
    ],
  );
  assert.equal(definition(toolkit, 'git_diff')?.operation?.title, '查看 git diff');
  assert.equal(definition(toolkit, 'git_commit')?.operation?.title, '创建 git commit');
  assert.equal(definition(toolkit, 'git_push')?.operation?.title, '推送 git 分支');
  assert.equal(definition(toolkit, 'gh_pr_create')?.operation?.title, '创建 GitHub PR');
  assert.equal(definition(toolkit, 'gh_pr_view')?.operation?.title, '查看 GitHub PR');
  assert.equal(definition(toolkit, 'gh_pr_diff')?.operation?.title, '查看 GitHub PR diff');
  assert.equal(definition(toolkit, 'gh_issue_comments')?.operation?.title, '查看 GitHub issue 评论');
  assert.equal(definition(toolkit, 'gh_read_content')?.operation?.title, '读取 GitHub 临时内容');
  assert.equal(Boolean(definition(toolkit, 'git_add')?.review), true);
  assert.equal(Boolean(definition(toolkit, 'git_commit')?.review), true);
  assert.equal(Boolean(definition(toolkit, 'git_push')?.review), true);
  assert.equal(Boolean(definition(toolkit, 'gh_pr_create')?.review), true);
  assert.equal(Boolean(definition(toolkit, 'gh_issue_create')?.review), true);

  const review = await definition(toolkit, 'git_commit')?.review?.request({
    toolkitName: 'git',
    toolName: 'git_commit',
    input: { cwd: '/repo', message: 'test: commit' },
    operation: definition(toolkit, 'git_commit')?.operation,
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
