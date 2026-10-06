import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { createAbortError, type NamedStructuredTool, type ToolOperationMetadata } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { readBoolean, readRecord, readString } from '../operationMetadata';
import {
  CLI_SHELL_TIMEOUT_MS,
  cliArgsSchema,
  createCliRunner,
  formatCliResult,
  readCliArgs,
  summarizeCliCall,
  truncateCliOutput,
  type CliCommandResult,
  type CliRunner,
} from '../cli/cliRunner';
import { readTextFileChunkResult } from '../files/fileTools';
import type { ShellExecResult, ShellRS } from '../shellRS/shellRS';
import { classifyGhArgs } from './ghCommands';

const MAX_GH_BODY_CHARS = 60_000;
const MAX_INLINE_GH_COMMENTS_CHARS = 100_000;
const MAX_GH_MARKDOWN_LINE_CHARS = 2_000;
const MAX_GH_CONTENT_CHARS = 60_000;
const DEFAULT_GH_CONTENT_LINE_COUNT = 100;
const MAX_GH_CONTENT_LINE_COUNT = 200;
const DEFAULT_GH_COMMENTS_PER_PAGE = 3;
const MAX_GH_COMMENTS_PER_PAGE = 5;
const MAX_GH_BUFFER_BYTES = 1024 * 1024 * 4;
const GH_TIMEOUT_MS = 20_000;
/** Prompts disabled: a command missing a required flag fails instead of hanging. */
const GH_SHELL_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0' };

function formatGhError(error: unknown) {
  if (!(error instanceof Error)) {
    return new Error(`gh command failed: ${String(error)}`);
  }

  const errorRecord = error as Error & {
    stdout?: unknown;
    stderr?: unknown;
    code?: unknown;
  };
  const stdout = typeof errorRecord.stdout === 'string' ? errorRecord.stdout.trimEnd() : '';
  const stderr = typeof errorRecord.stderr === 'string' ? errorRecord.stderr.trimEnd() : '';
  const output = truncateCliOutput([stdout, stderr].filter(Boolean).join('\n'));
  const prefix = typeof errorRecord.code === 'number'
    ? `gh command failed (exit ${errorRecord.code})`
    : `gh command failed: ${error.message}`;

  return new Error(output ? `${prefix}:\n${output}` : prefix);
}

function createGhToolError(name: string, error: unknown, runtime: ToolRuntime) {
  const formatted = error instanceof Error ? error : new Error(String(error));
  if (!runtime.toolCallId) throw formatted;
  return new ToolMessage({
    status: 'error',
    content: `Error: ${formatted.message}`,
    name,
    tool_call_id: runtime.toolCallId,
  });
}

function resolveGhWorkdir(cwd?: string) {
  return cwd?.trim() || process.cwd();
}

type GhExecOptions = { timeoutMs?: number; env?: Readonly<Record<string, string>> };

async function executeGh(cli: CliRunner, args: string[], cwd?: string, options: GhExecOptions = {}) {
  const repo = resolveGhWorkdir(cwd);
  const timeoutMs = options.timeoutMs ?? GH_TIMEOUT_MS;
  let result: ShellExecResult;
  try {
    result = await cli(['gh', ...args], {
      cwd: repo,
      timeoutMs,
      maxOutputChars: MAX_GH_BUFFER_BYTES,
      ...(options.env ? { env: options.env } : {}),
    });
  } catch (err) {
    throw formatGhError(err);
  }
  switch (result.status) {
    case 'exited':
      if (result.code !== 0) {
        throw formatGhError(Object.assign(new Error(
          result.code === null ? 'terminated by a signal' : 'gh command failed',
        ), {
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.code ?? undefined,
        }));
      }
      return { stdout: result.stdout, stderr: result.stderr } satisfies CliCommandResult;
    case 'timeout':
      throw formatGhError(Object.assign(
        new Error(`timed out after ${(timeoutMs / 1000).toString()}s`),
        { stdout: result.stdout, stderr: result.stderr },
      ));
    case 'aborted':
      throw createAbortError();
    case 'spawn_failed':
      throw formatGhError(result.error);
    case 'yielded':
      throw formatGhError(new Error('gh command unexpectedly kept running'));
  }
}

async function runGh(
  cli: CliRunner,
  args: string[],
  cwd?: string,
  emptyOutput?: string,
  options?: GhExecOptions,
) {
  const result = await executeGh(cli, args, cwd, options);

  const output = formatCliResult(result);
  if (output === '(no output)') {
    if (emptyOutput !== undefined) return emptyOutput;
    throw new Error('gh command returned no output');
  }
  return output;
}

async function runGhJson(cli: CliRunner, args: string[], cwd?: string) {
  const result = await executeGh(cli, args, cwd);
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (!stdout) {
    throw new Error('gh command returned no output');
  }
  try {
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`gh command returned invalid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

type ResolvedGhIssueTarget = {
  hostname: string;
  repository: string;
  issueNumber: number;
};

function parseGhIssueUrl(value: string): ResolvedGhIssueTarget | null {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 4 || parts[2] !== 'issues' || !/^\d+$/.test(parts[3])) {
      return null;
    }
    return {
      hostname: url.hostname,
      repository: `${parts[0]}/${parts[1]}`,
      issueNumber: Number(parts[3]),
    };
  } catch {
    return null;
  }
}

async function resolveGhIssueTarget(
  cli: CliRunner,
  issue: string,
  cwd?: string,
): Promise<ResolvedGhIssueTarget> {
  const target = normalizeGhTarget(issue, 'issue');
  const urlTarget = parseGhIssueUrl(target);
  if (urlTarget) return urlTarget;
  if (!/^\d+$/.test(target)) {
    throw new Error('issue must be an issue number or URL');
  }

  const repository = readRecord(await runGhJson(cli, [
    'repo',
    'view',
    '--json',
    'nameWithOwner,url',
  ], cwd));
  const nameWithOwner = readString(repository, 'nameWithOwner');
  const repositoryUrl = readString(repository, 'url');
  if (!nameWithOwner || !repositoryUrl) {
    throw new Error('unable to resolve the current GitHub repository');
  }

  return {
    hostname: new URL(repositoryUrl).hostname,
    repository: nameWithOwner,
    issueNumber: Number(target),
  };
}

function ghApiArgs(target: ResolvedGhIssueTarget, endpoint: string) {
  return target.hostname === 'github.com'
    ? ['api', endpoint]
    : ['api', '--hostname', target.hostname, endpoint];
}

function truncateBody(value: unknown) {
  const body = typeof value === 'string' ? value : '';
  const truncated = body.length > MAX_GH_BODY_CHARS;
  let returnedChars = truncated ? MAX_GH_BODY_CHARS : body.length;
  if (
    truncated
    && returnedChars > 0
    && body.charCodeAt(returnedChars - 1) >= 0xd800
    && body.charCodeAt(returnedChars - 1) <= 0xdbff
    && body.charCodeAt(returnedChars) >= 0xdc00
    && body.charCodeAt(returnedChars) <= 0xdfff
  ) {
    returnedChars -= 1;
  }
  return {
    body: truncated ? body.slice(0, returnedChars) : body,
    bodyTruncation: {
      truncated,
      originalChars: body.length,
      returnedChars,
    },
  };
}

function normalizeGhUser(value: unknown) {
  const user = readRecord(value);
  return user ? { login: readString(user, 'login') } : null;
}

function normalizeGhLabels(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const label = readRecord(item);
    return {
      name: readString(label, 'name'),
      color: readString(label, 'color'),
      description: readString(label, 'description'),
    };
  });
}

function normalizeGhAssignees(value: unknown) {
  return Array.isArray(value) ? value.map(normalizeGhUser).filter(Boolean) : [];
}

function normalizeGhComment(value: unknown) {
  const comment = readRecord(value);
  return {
    id: typeof comment?.id === 'number' ? comment.id : null,
    author: normalizeGhUser(comment?.user),
    createdAt: readString(comment, 'created_at'),
    updatedAt: readString(comment, 'updated_at'),
    url: readString(comment, 'html_url'),
    body: readString(comment, 'body') ?? '',
  };
}

async function loadGhIssue(cli: CliRunner, issue: string, cwd?: string) {
  const target = await resolveGhIssueTarget(cli, issue, cwd);
  const issueEndpoint = `repos/${target.repository}/issues/${target.issueNumber}`;
  const issueRecord = readRecord(await runGhJson(cli, ghApiArgs(target, issueEndpoint), cwd));
  if (!issueRecord) throw new Error('gh issue response was not an object');
  return { target, issueEndpoint, issue: issueRecord };
}

function ghContentRoot(cwd?: string) {
  return resolve(resolveGhWorkdir(cwd), '.pinpawo', 'tmp', 'gh');
}

function resolveGhContentPath(path: string, cwd?: string) {
  const root = ghContentRoot(cwd);
  const relativePath = relative(root, path);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`gh_read_content only reads files under ${root}`);
  }
  return path;
}

function safeGhFileSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'github';
}

function wrapGhMarkdownBody(body: string) {
  return body.split('\n').flatMap((line) => {
    if (line.length <= MAX_GH_MARKDOWN_LINE_CHARS) return [line];
    const chunks: string[] = [];
    let offset = 0;
    while (offset < line.length) {
      let end = Math.min(offset + MAX_GH_MARKDOWN_LINE_CHARS, line.length);
      const finalCodeUnit = line.charCodeAt(end - 1);
      const nextCodeUnit = line.charCodeAt(end);
      if (
        end < line.length
        && finalCodeUnit >= 0xd800
        && finalCodeUnit <= 0xdbff
        && nextCodeUnit >= 0xdc00
        && nextCodeUnit <= 0xdfff
      ) {
        end -= 1;
      }
      chunks.push(line.slice(offset, end));
      offset = end;
    }
    return chunks;
  }).join('\n');
}

function formatGhCommentsMarkdown(input: {
  target: ResolvedGhIssueTarget;
  issue: Record<string, unknown>;
  comments: ReturnType<typeof normalizeGhComment>[];
  page: number;
  perPage: number;
}) {
  const issueTitle = (readString(input.issue, 'title') ?? '').replace(/\s+/g, ' ').trim();
  const lines = [
    `# ${input.target.repository} issue #${input.target.issueNumber} comments`,
    '',
    `- Title: ${issueTitle || '(untitled)'}`,
    `- Page: ${input.page}`,
    `- Per page: ${input.perPage}`,
    '',
  ];
  input.comments.forEach((comment, index) => {
    lines.push(
      `## Comment ${(input.page - 1) * input.perPage + index + 1}`,
      '',
      `- ID: ${comment.id ?? '(unknown)'}`,
      `- Author: ${comment.author?.login ?? '(unknown)'}`,
      `- Created: ${comment.createdAt ?? '(unknown)'}`,
      `- Updated: ${comment.updatedAt ?? '(unknown)'}`,
      `- URL: ${comment.url ?? '(unknown)'}`,
      '',
      wrapGhMarkdownBody(comment.body) || '(empty body)',
      '',
    );
  });
  return `${lines.join('\n')}\n`;
}

function writeGhCommentsContent(input: {
  cwd?: string;
  target: ResolvedGhIssueTarget;
  issue: Record<string, unknown>;
  comments: ReturnType<typeof normalizeGhComment>[];
  page: number;
  perPage: number;
}) {
  const root = ghContentRoot(input.cwd);
  mkdirSync(root, { recursive: true });
  const repository = safeGhFileSegment(`${input.target.hostname}-${input.target.repository}`);
  const content = formatGhCommentsMarkdown(input);
  const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 12);
  const filePath = resolve(
    root,
    `${repository}-issue-${input.target.issueNumber}-comments-page-${input.page}-per-page-${input.perPage}-${contentHash}.md`,
  );
  writeFileSync(filePath, content, 'utf-8');
  return {
    delivery: 'file',
    format: 'markdown',
    path: filePath,
    cwd: resolveGhWorkdir(input.cwd),
    chars: content.length,
    bytes: Buffer.byteLength(content, 'utf-8'),
    truncated: false,
    longLinesWrappedAtChars: MAX_GH_MARKDOWN_LINE_CHARS,
    readWith: 'gh_read_content',
  };
}

async function viewGhIssue(cli: CliRunner, input: { cwd?: string; issue: string }) {
  const { target, issue } = await loadGhIssue(cli, input.issue, input.cwd);

  const body = truncateBody(issue.body);
  const milestone = readRecord(issue.milestone);
  return JSON.stringify({
    number: typeof issue.number === 'number' ? issue.number : target.issueNumber,
    title: readString(issue, 'title'),
    state: readString(issue, 'state'),
    author: normalizeGhUser(issue.user),
    labels: normalizeGhLabels(issue.labels),
    assignees: normalizeGhAssignees(issue.assignees),
    milestone: milestone
      ? {
          number: typeof milestone.number === 'number' ? milestone.number : null,
          title: readString(milestone, 'title'),
          state: readString(milestone, 'state'),
        }
      : null,
    url: readString(issue, 'html_url'),
    ...body,
    commentsTotal: typeof issue.comments === 'number' ? issue.comments : 0,
  });
}

async function viewGhIssueComments(cli: CliRunner, input: {
  cwd?: string;
  issue: string;
  page: number;
  perPage: number;
}) {
  const { target, issueEndpoint, issue } = await loadGhIssue(cli, input.issue, input.cwd);
  const totalComments = typeof issue.comments === 'number' ? issue.comments : 0;
  const commentsEndpoint = `${issueEndpoint}/comments?per_page=${input.perPage}&page=${input.page}`;
  const rawComments = totalComments > 0
    ? await runGhJson(cli, ghApiArgs(target, commentsEndpoint), input.cwd)
    : [];
  if (!Array.isArray(rawComments)) throw new Error('gh issue comments response was not an array');

  const comments = rawComments.map(normalizeGhComment);
  const inlineComments = comments.map(({ body, ...metadata }) => ({
    ...metadata,
    ...truncateBody(body),
  }));
  const inlineChars = JSON.stringify(inlineComments).length;
  const useContentFile = inlineChars > MAX_INLINE_GH_COMMENTS_CHARS
    || comments.some((comment) => comment.body.length > MAX_GH_BODY_CHARS);
  const returnedComments = useContentFile
    ? comments.map(({ body, ...metadata }) => ({ ...metadata, bodyChars: body.length }))
    : inlineComments;
  const commentsContent = useContentFile
    ? writeGhCommentsContent({ ...input, target, issue, comments })
    : {
        delivery: 'inline',
        format: 'json',
        chars: inlineChars,
        truncated: false,
      };

  return JSON.stringify({
    issue: {
      number: typeof issue.number === 'number' ? issue.number : target.issueNumber,
      title: readString(issue, 'title'),
      url: readString(issue, 'html_url'),
    },
    comments: returnedComments,
    commentsPagination: {
      page: input.page,
      perPage: input.perPage,
      returnedCount: returnedComments.length,
      totalCount: totalComments,
      hasPreviousPage: totalComments > 0 && input.page > 1,
      hasNextPage: input.page * input.perPage < totalComments,
    },
    commentsContent,
  });
}

function normalizeGhTarget(value: string | undefined, label: string) {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

/** Only risky gh_shell calls are reviewed; reads and everyday collaboration run directly. */
export function ghShellCallNeedsReview(input: unknown) {
  return classifyGhArgs(readCliArgs(input)).level === 'risky';
}

/** GitHub tools, running every gh invocation as argv through the injected ShellRS. */
export function createGithubTools(shell: ShellRS) {
  const cliFor = (runtime: ToolRuntime) => createCliRunner(shell, runtime);

  const ghPrCreateTool = tool(
    async ({ cwd, title, body = '', base, head, repository, draft = false }: {
      cwd?: string;
      title: string;
      body?: string;
      base?: string;
      head?: string;
      repository?: string;
      draft?: boolean;
    }, runtime: ToolRuntime) => {
      try {
        const args = ['pr', 'create', '--title', title.trim(), '--body', body];
        if (base?.trim()) args.push('--base', base.trim());
        if (head?.trim()) args.push('--head', head.trim());
        if (repository?.trim()) args.push('--repo', repository.trim());
        if (draft) args.push('--draft');
        return await runGh(cliFor(runtime), args, cwd);
      } catch (error) {
        return createGhToolError('gh_pr_create', error, runtime);
      }
    },
    {
      name: 'gh_pr_create',
      description: '使用 GitHub CLI 创建 pull request。必须显式提供标题，正文可为空；默认使用当前仓库、当前分支和仓库默认 base。',
      schema: z.object({
        cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
        title: z.string().trim().min(1).describe('PR 标题'),
        body: z.string().optional().describe('PR 正文；默认空字符串'),
        base: z.string().trim().min(1).optional().describe('目标分支；默认仓库默认分支'),
        head: z.string().trim().min(1).optional().describe('来源分支；默认当前分支'),
        repository: z.string().trim().min(1).optional().describe('目标仓库 owner/name；默认当前仓库'),
        draft: z.boolean().optional().describe('是否创建为 draft PR，默认 false'),
      }),
    },
  );

  const ghIssueCreateTool = tool(
    async ({ cwd, title, body = '', repository }: {
      cwd?: string;
      title: string;
      body?: string;
      repository?: string;
    }, runtime: ToolRuntime) => {
      try {
        const args = ['issue', 'create', '--title', title.trim(), '--body', body];
        if (repository?.trim()) args.push('--repo', repository.trim());
        return await runGh(cliFor(runtime), args, cwd);
      } catch (error) {
        return createGhToolError('gh_issue_create', error, runtime);
      }
    },
    {
      name: 'gh_issue_create',
      description: '使用 GitHub CLI 创建 issue。必须显式提供标题，正文可为空；默认使用当前仓库。',
      schema: z.object({
        cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
        title: z.string().trim().min(1).describe('Issue 标题'),
        body: z.string().optional().describe('Issue 正文；默认空字符串'),
        repository: z.string().trim().min(1).optional().describe('目标仓库 owner/name；默认当前仓库'),
      }),
    },
  );

  const ghIssueListTool = tool(
    async ({ cwd, repository, state = 'open', limit = 30, search }: {
      cwd?: string;
      repository?: string;
      state?: 'open' | 'closed' | 'all';
      limit?: number;
      search?: string;
    }, runtime: ToolRuntime) => {
      try {
        const args = [
          'issue',
          'list',
          '--state',
          state,
          '--limit',
          String(limit),
          '--json',
          'number,title,state,labels,assignees,author,url,updatedAt',
        ];
        if (repository?.trim()) args.push('--repo', repository.trim());
        if (search?.trim()) args.push('--search', search.trim());
        return await runGh(cliFor(runtime), args, cwd, '[]');
      } catch (error) {
        return createGhToolError('gh_issue_list', error, runtime);
      }
    },
    {
      name: 'gh_issue_list',
      description: '列出 GitHub issue 的结构化快照。可按状态、仓库和 GitHub 搜索表达式筛选；用于从尚未知晓编号的 issue 中发现候选，再用 gh_issue_view 读取选中项。',
      schema: z.object({
        cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
        repository: z.string().trim().min(1).optional().describe('目标仓库 owner/name；默认当前仓库'),
        state: z.enum(['open', 'closed', 'all']).optional().describe('Issue 状态，默认 open'),
        limit: z.number().int().positive().max(100).optional().describe('最多返回条数，默认 30，最大 100'),
        search: z.string().trim().min(1).optional().describe('可选 GitHub issue 搜索表达式，例如 label:priority-high 或 sort:updated-desc'),
      }),
    },
  );

  const ghPrViewTool = tool(
    async ({ cwd, pr }: { cwd?: string; pr: string }, runtime: ToolRuntime) => {
      try {
        return await runGh(cliFor(runtime), ['pr', 'view', normalizeGhTarget(pr, 'pr')], cwd);
      } catch (error) {
        return createGhToolError('gh_pr_view', error, runtime);
      }
    },
    {
      name: 'gh_pr_view',
      description: '使用 GitHub CLI 查看 PR 概览、元数据和描述，不读取评论。pr 可为 PR 编号、URL 或分支名；默认当前 workdir 仓库。',
      schema: z.object({
        cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
        pr: z.string().min(1).describe('PR 编号、URL 或分支名'),
      }),
    },
  );

  const ghPrCommentsTool = tool(
    async ({ cwd, pr }: { cwd?: string; pr: string }, runtime: ToolRuntime) => {
      try {
        return await runGh(cliFor(runtime), 
          ['pr', 'view', normalizeGhTarget(pr, 'pr'), '--comments'],
          cwd,
          '(no PR comments or reviews)',
        );
      } catch (error) {
        return createGhToolError('gh_pr_comments', error, runtime);
      }
    },
    {
      name: 'gh_pr_comments',
      description: '使用 GitHub CLI 查看 PR review 和评论；没有 review 或评论时返回明确的空结果。pr 可为 PR 编号、URL 或分支名；输出受统一长度上限约束。',
      schema: z.object({
        cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
        pr: z.string().min(1).describe('PR 编号、URL 或分支名'),
      }),
    },
  );

  const ghPrDiffTool = tool(
    async ({ cwd, pr }: { cwd?: string; pr: string }, runtime: ToolRuntime) => {
      try {
        return await runGh(cliFor(runtime), 
          ['pr', 'diff', normalizeGhTarget(pr, 'pr'), '--patch'],
          cwd,
          '(empty diff)',
        );
      } catch (error) {
        return createGhToolError('gh_pr_diff', error, runtime);
      }
    },
    {
      name: 'gh_pr_diff',
      description: '使用 GitHub CLI 查看 PR patch diff。pr 可为 PR 编号、URL 或分支名；用于代码 review，不要用 browser/http_fetch 拉取 PR diff。',
      schema: z.object({
        cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
        pr: z.string().min(1).describe('PR 编号、URL 或分支名'),
      }),
    },
  );

  const ghIssueViewTool = tool(
    async ({ cwd, issue }: { cwd?: string; issue: string }, runtime: ToolRuntime) => {
      try {
        return await viewGhIssue(cliFor(runtime), { cwd, issue });
      } catch (error) {
        return createGhToolError('gh_issue_view', error, runtime);
      }
    },
    {
      name: 'gh_issue_view',
      description: '使用 GitHub CLI 查看 issue 元数据、描述和评论总数，不自动读取评论正文。需要评论时继续调用 gh_issue_comments；issue 可为 issue 编号或 URL，默认当前 workdir 仓库。',
      schema: z.object({
        cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
        issue: z.string().min(1).describe('Issue 编号或 URL'),
      }),
    },
  );

  const ghIssueCommentsTool = tool(
    async ({
      cwd,
      issue,
      page = 1,
      perPage = DEFAULT_GH_COMMENTS_PER_PAGE,
    }: {
      cwd?: string;
      issue: string;
      page?: number;
      perPage?: number;
    }, runtime: ToolRuntime) => {
      try {
        return await viewGhIssueComments(cliFor(runtime), { cwd, issue, page, perPage });
      } catch (error) {
        return createGhToolError('gh_issue_comments', error, runtime);
      }
    },
    {
      name: 'gh_issue_comments',
      description: '分页读取 GitHub issue 评论，默认每页 3 条、最多 5 条。普通页面直接返回正文；页面过大时完整内容写入 Markdown，并返回可交给 gh_read_content 的路径。',
      schema: z.object({
        cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
        issue: z.string().min(1).describe('Issue 编号或 URL'),
        page: z.number().int().positive().optional()
          .describe('评论页码，默认 1；根据 commentsPagination.hasNextPage 继续翻页'),
        perPage: z.number().int().positive().max(MAX_GH_COMMENTS_PER_PAGE).optional()
          .describe(`每页评论数，默认 ${DEFAULT_GH_COMMENTS_PER_PAGE}，最大 ${MAX_GH_COMMENTS_PER_PAGE}`),
      }),
    },
  );

  const ghReadContentTool = tool(
    async ({
      cwd,
      path,
      startLine = 1,
      lineCount = DEFAULT_GH_CONTENT_LINE_COUNT,
    }: {
      cwd?: string;
      path: string;
      startLine?: number;
      lineCount?: number;
    }, runtime: ToolRuntime) => {
      try {
        const filePath = resolveGhContentPath(path, cwd);
        const chunk = readTextFileChunkResult({
          path: filePath,
          startLine,
          endLine: startLine + lineCount - 1,
          maxBytes: MAX_GH_CONTENT_CHARS,
        });
        return JSON.stringify({ path: filePath, ...chunk });
      } catch (error) {
        return createGhToolError('gh_read_content', error, runtime);
      }
    },
    {
      name: 'gh_read_content',
      description: `按行读取 gh_issue_comments 生成的临时 Markdown。默认请求 ${DEFAULT_GH_CONTENT_LINE_COUNT} 行、最多 ${MAX_GH_CONTENT_LINE_COUNT} 行，但每次正文最多返回 ${MAX_GH_CONTENT_CHARS} 字节；根据 nextStartLine 继续读取。仅允许读取对应 cwd 下 .pinpawo/tmp/gh 中的文件。`,
      schema: z.object({
        cwd: z.string().optional().describe('生成内容时返回的 cwd；默认当前 workdir'),
        path: z.string().min(1).describe('gh_issue_comments 返回的 commentsContent.path'),
        startLine: z.number().int().positive().optional().describe('起始行号，默认 1'),
        lineCount: z.number().int().positive().max(MAX_GH_CONTENT_LINE_COUNT).optional()
          .describe(`读取行数，默认 ${DEFAULT_GH_CONTENT_LINE_COUNT}，最大 ${MAX_GH_CONTENT_LINE_COUNT}`),
      }),
    },
  );

  const ghShellTool = tool(
    async ({ cwd, args }: { cwd?: string; args: string[] }, runtime: ToolRuntime) => {
      try {
        return await runGh(cliFor(runtime), args, cwd, '(no output)', {
          timeoutMs: CLI_SHELL_TIMEOUT_MS,
          env: GH_SHELL_ENV,
        });
      } catch (error) {
        return createGhToolError('gh_shell', error, runtime);
      }
    },
    {
      name: 'gh_shell',
      description: '执行一条 GitHub CLI（gh）命令，用于 gh_* 专用工具没有覆盖的操作，例如 pr checks、pr list、CI 运行日志、PR 评论与 review、search、api。直接以参数数组执行，不经 shell。查看 PR 概览、diff、评论和 issue 时仍优先用对应 gh_* 工具。'
        + '查询和日常协作（创建 PR/issue、评论、review、编辑、关闭/重开、重跑 CI 等）直接执行。'
        + '合并 PR、删除、发布 release、改 secret/权限/仓库设置、登录凭据、扩展，以及写入类 api 要审批。被拒绝后不要换工具绕过。'
        + '不会弹出交互提示：缺少必需参数时命令直接失败，例如 pr merge 需显式给出 --merge、--squash 或 --rebase。不要用 --web 打开浏览器。超时 120 秒。',
      schema: z.object({
        cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
        args: cliArgsSchema('gh', '["pr", "checks", "123"]'),
      }),
    },
  );

  const githubTools = [
    ghPrCreateTool as NamedStructuredTool<'gh_pr_create'>,
    ghPrViewTool as NamedStructuredTool<'gh_pr_view'>,
    ghPrCommentsTool as NamedStructuredTool<'gh_pr_comments'>,
    ghPrDiffTool as NamedStructuredTool<'gh_pr_diff'>,
    ghIssueCreateTool as NamedStructuredTool<'gh_issue_create'>,
    ghIssueListTool as NamedStructuredTool<'gh_issue_list'>,
    ghIssueViewTool as NamedStructuredTool<'gh_issue_view'>,
    ghIssueCommentsTool as NamedStructuredTool<'gh_issue_comments'>,
    ghReadContentTool as NamedStructuredTool<'gh_read_content'>,
    ghShellTool as NamedStructuredTool<'gh_shell'>,
  ] as const;

  /** The read-only subset, composed into project-inspection. */
  const githubInspectionTools = [
    ghPrViewTool as NamedStructuredTool<'gh_pr_view'>,
    ghPrCommentsTool as NamedStructuredTool<'gh_pr_comments'>,
    ghPrDiffTool as NamedStructuredTool<'gh_pr_diff'>,
    ghIssueListTool as NamedStructuredTool<'gh_issue_list'>,
    ghIssueViewTool as NamedStructuredTool<'gh_issue_view'>,
    ghIssueCommentsTool as NamedStructuredTool<'gh_issue_comments'>,
    ghReadContentTool as NamedStructuredTool<'gh_read_content'>,
  ] as const;

  return { githubTools, githubInspectionTools };
}

export const githubOperationMetadata = {
  gh_pr_create: {
    title: '创建 GitHub PR',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'repository') ?? readString(record, 'base') ?? readString(record, 'cwd'),
        summary: readString(record, 'title'),
        details: {
          head: readString(record, 'head'),
          draft: readBoolean(record, 'draft'),
        },
      };
    },
  },
  gh_pr_view: {
    title: '查看 GitHub PR',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'pr') ?? readString(record, 'cwd'),
      };
    },
  },
  gh_pr_comments: {
    title: '查看 GitHub PR 评论',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'pr') ?? readString(record, 'cwd'),
      };
    },
  },
  gh_pr_diff: {
    title: '查看 GitHub PR diff',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'pr') ?? readString(record, 'cwd'),
      };
    },
  },
  gh_issue_create: {
    title: '创建 GitHub issue',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'repository') ?? readString(record, 'cwd'),
        summary: readString(record, 'title'),
      };
    },
  },
  gh_issue_list: {
    title: '列出 GitHub issue',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'repository') ?? readString(record, 'cwd'),
        summary: readString(record, 'search'),
      };
    },
  },
  gh_issue_view: {
    title: '查看 GitHub issue',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'issue') ?? readString(record, 'cwd'),
      };
    },
  },
  gh_issue_comments: {
    title: '查看 GitHub issue 评论',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'issue') ?? readString(record, 'cwd'),
      };
    },
  },
  gh_read_content: {
    title: '读取 GitHub 临时内容',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'path'),
      };
    },
  },
  gh_shell: {
    title: '执行 gh 命令',
    summarizeInput: (input) => summarizeCliCall('gh', input, classifyGhArgs),
  },
} satisfies Record<
  ReturnType<typeof createGithubTools>['githubTools'][number]['name'],
  ToolOperationMetadata
>;
