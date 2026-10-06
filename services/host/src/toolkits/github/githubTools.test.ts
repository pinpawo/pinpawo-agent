import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ToolMessage } from '@langchain/core/messages';
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
const ghIssueListTool = sessionTool('gh_issue_list');
const ghIssueCommentsTool = sessionTool('gh_issue_comments');
const ghIssueViewTool = sessionTool('gh_issue_view');
const ghPrCommentsTool = sessionTool('gh_pr_comments');
const ghPrCreateTool = sessionTool('gh_pr_create');
const ghPrDiffTool = sessionTool('gh_pr_diff');
const ghPrViewTool = sessionTool('gh_pr_view');
const ghReadContentTool = sessionTool('gh_read_content');
const ghShellTool = sessionTool('gh_shell');

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

test('gh_issue_list discovers structured issue candidates without shell commands', async (t) => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-gh-issue-list-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  createFakeGh(t, `
case "$*" in
  "issue list --state open --limit 20 --json number,title,state,labels,assignees,author,url,updatedAt --repo pinpawo/pinpawo-agent --search label:priority-high")
    printf '[{"number":645,"title":"Planner routing","state":"OPEN"}]\\n'
    ;;
  *)
    printf 'unexpected gh arguments: %s\\n' "$*" >&2
    exit 2
    ;;
esac`);

  assert.deepEqual(
    JSON.parse(String(await ghIssueListTool.invoke({
      cwd: workdir,
      repository: 'pinpawo/pinpawo-agent',
      state: 'open',
      limit: 20,
      search: 'label:priority-high',
    }))),
    [{ number: 645, title: 'Planner routing', state: 'OPEN' }],
  );
});

test('gh_pr_view reads bounded overview while gh_pr_comments owns discussion', async (t) => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-gh-pr-view-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const prUrl = 'https://github.com/pinpawo/pinpawo-agent/pull/12';
  const fakeGh = createFakeGh(t, `
case "$*" in
  "pr view 12"|"pr view ${prUrl}"|"pr view codex/fix")
    printf 'Fix empty PR comments\\nstate: OPEN\\nauthor: octocat\\nbody: Details\\n'
    ;;
  "pr view 12 --comments"|"pr view ${prUrl} --comments"|"pr view codex/fix --comments")
    exit 0
    ;;
  *)
    printf 'unexpected gh arguments: %s\\n' "$*" >&2
    exit 2
    ;;
esac`);

  const expected = 'Fix empty PR comments\nstate: OPEN\nauthor: octocat\nbody: Details';
  assert.equal(await ghPrViewTool.invoke({ cwd: workdir, pr: '12' }), expected);
  assert.equal(await ghPrViewTool.invoke({ cwd: workdir, pr: prUrl }), expected);
  assert.equal(await ghPrViewTool.invoke({ cwd: workdir, pr: 'codex/fix' }), expected);
  assert.equal(
    await ghPrCommentsTool.invoke({ cwd: workdir, pr: '12' }),
    '(no PR comments or reviews)',
  );
  assert.equal(
    await ghPrCommentsTool.invoke({ cwd: workdir, pr: prUrl }),
    '(no PR comments or reviews)',
  );

  writeFileSync(fakeGh, `#!/bin/sh
case "$*" in
  "pr view 12")
    awk 'BEGIN { for (i = 0; i < 30001; i++) printf "x" }'
    ;;
esac
`, 'utf-8');
  const boundedOverview = String(await ghPrViewTool.invoke({ cwd: workdir, pr: '12' }));
  assert.equal(boundedOverview.startsWith('x'.repeat(30_000)), true);
  assert.match(boundedOverview, /\[truncated 1 chars\]$/);

  writeFileSync(fakeGh, `#!/bin/sh
case "$*" in
  "pr view 12 --comments")
    printf 'Reviewed PR\\nreview: CHANGES_REQUESTED\\ncomment: Please add a test.\\n'
    ;;
  *)
    printf 'fallback should not run: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`, 'utf-8');
  assert.match(
    String(await ghPrCommentsTool.invoke({ cwd: workdir, pr: '12' })),
    /comment: Please add a test\./,
  );

  writeFileSync(fakeGh, '#!/bin/sh\nexit 0\n', 'utf-8');
  await assert.rejects(
    () => ghPrViewTool.invoke({ cwd: workdir, pr: '12' }),
    /gh command returned no output/,
  );
  assert.equal(
    await ghPrCommentsTool.invoke({ cwd: workdir, pr: '12' }),
    '(no PR comments or reviews)',
  );

  writeFileSync(fakeGh, '#!/bin/sh\nprintf \'authentication required\\n\' >&2\nexit 1\n', 'utf-8');
  await assert.rejects(
    () => ghPrViewTool.invoke({ cwd: workdir, pr: '12' }),
    /gh command failed \(exit 1\):\nauthentication required/,
  );
  await assert.rejects(
    () => ghPrCommentsTool.invoke({ cwd: workdir, pr: '12' }),
    /gh command failed \(exit 1\):\nauthentication required/,
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

test('createGithubToolkit exposes the GitHub surface', () => {
  const toolkit = createGithubToolkit({ shell: new PosixShellRS() });
  assert.equal(toolkit.name, 'github');
  assert.deepEqual(
    toolkit.tools.map((item) => item.tool.name),
    ['gh_pr_create', 'gh_pr_view', 'gh_pr_comments', 'gh_pr_diff', 'gh_issue_create', 'gh_issue_list',
      'gh_issue_view', 'gh_issue_comments', 'gh_read_content', 'gh_shell'],
  );
  assert.equal(definition(toolkit, 'gh_pr_create')?.operation?.title, '创建 GitHub PR');
  assert.equal(definition(toolkit, 'gh_pr_view')?.operation?.title, '查看 GitHub PR');
  assert.equal(definition(toolkit, 'gh_pr_comments')?.operation?.title, '查看 GitHub PR 评论');
  assert.equal(definition(toolkit, 'gh_pr_diff')?.operation?.title, '查看 GitHub PR diff');
  assert.equal(definition(toolkit, 'gh_issue_comments')?.operation?.title, '查看 GitHub issue 评论');
  assert.equal(definition(toolkit, 'gh_read_content')?.operation?.title, '读取 GitHub 临时内容');
  for (const name of ['gh_pr_create', 'gh_issue_create']) {
    assert.equal(definition(toolkit, name)?.review, undefined, `${name} runs without review`);
  }
});

test('gh_shell reviews only risky calls', async () => {
  const toolkit = createGithubToolkit({ shell: new PosixShellRS() });
  const reviewOf = async (args: string[]) => {
    const found = definition(toolkit, 'gh_shell');
    assert.ok(found?.review);
    return found.review.request({
      toolkitName: 'github',
      toolName: 'gh_shell',
      input: { cwd: '/repo', args },
      operation: found.operation,
      reviewCapabilities: { humanReview: true, sessionAuthorization: true },
    });
  };
  assert.equal(await reviewOf(['pr', 'checks', '12']), null);
  assert.equal(await reviewOf(['api', 'repos/o/r/pulls']), null);
  // Everyday collaboration leans permissive.
  assert.equal(await reviewOf(['pr', 'comment', '12', '--body', 'LGTM']), null);
  assert.equal(await reviewOf(['pr', 'close', '12']), null);
  for (const args of [['pr', 'merge', '12', '--squash'], ['api', '-X', 'DELETE', 'repos/o/r']]) {
    const review = await reviewOf(args);
    assert.ok(review && 'schemaVersion' in review, `gh ${args.join(' ')} must be reviewed`);
    assert.equal(review.view.kind === 'plain' ? review.view.title : '', definition(toolkit, 'gh_shell')?.operation?.title);
  }
});

test('gh_shell passes argv through with prompts disabled', async (t) => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-gh-shell-'));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  createFakeGh(t, 'printf "%s|%s\\n" "$*" "$GH_PROMPT_DISABLED"');
  assert.equal(
    await ghShellTool.invoke({ cwd: workdir, args: ['pr', 'comment', '12', '--body', 'two words'] }),
    'pr comment 12 --body two words|1',
  );
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
  const ghPrView = createGithubTools(shell).githubTools.find((item) => item.name === 'gh_pr_view')!;
  await assert.rejects(
    () => ghPrView.invoke({ pr: '1' } as never, { context: sessionContext }),
    /gh command failed: terminated by a signal/,
  );
});
