import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import {
  type NamedStructuredTool,
  type ToolOperationMetadata,
} from '@pinpawo/pet-agent';
import { z } from 'zod';
import { readBoolean, readRecord, readString } from '../operationMetadata';
import { readTextFileChunkResult } from './fileTools';
import { getLocalToolsWorkdir, resolveUserPath } from './pathUtils';

const MAX_GIT_OUTPUT_CHARS = 30_000;
const MAX_GH_BODY_CHARS = 60_000;
const MAX_INLINE_GH_COMMENTS_CHARS = 100_000;
const MAX_GH_MARKDOWN_LINE_CHARS = 2_000;
const MAX_GH_CONTENT_CHARS = 60_000;
const DEFAULT_GH_CONTENT_LINE_COUNT = 100;
const MAX_GH_CONTENT_LINE_COUNT = 200;
const DEFAULT_GH_COMMENTS_PER_PAGE = 3;
const MAX_GH_COMMENTS_PER_PAGE = 5;
const MAX_GH_BUFFER_BYTES = 1024 * 1024 * 4;
const DEFAULT_GIT_TIMEOUT_MS = 15_000;
const GIT_PUSH_TIMEOUT_MS = 120_000;
const execFileAsync = promisify(execFile);

type GitCommandResult = {
  stdout?: unknown;
  stderr?: unknown;
  status?: number | null;
  error?: Error;
};

function truncateOutput(output: string) {
  if (output.length <= MAX_GIT_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_GIT_OUTPUT_CHARS)}\n[truncated ${output.length - MAX_GIT_OUTPUT_CHARS} chars]`;
}

function normalizePathspecs(pathspecs: string[] | undefined) {
  return Array.isArray(pathspecs)
    ? pathspecs.map((item) => item.trim()).filter(Boolean)
    : [];
}

function formatGitResult(result: GitCommandResult) {
  const stdout = typeof result.stdout === 'string' ? result.stdout.trimEnd() : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr.trimEnd() : '';
  const output = [stdout, stderr].filter(Boolean).join('\n');

  if (result.status && result.status !== 0) {
    return `Error (exit ${result.status}):\n${truncateOutput(output || 'git command failed')}`;
  }

  if (result.error) {
    return `Error: ${result.error.message}`;
  }

  return truncateOutput(output || '(no output)');
}

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
  const output = truncateOutput([stdout, stderr].filter(Boolean).join('\n'));
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

export async function runGit(
  args: string[],
  cwd?: string,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
) {
  const repo = cwd?.trim() ? resolveUserPath(cwd.trim()) : getLocalToolsWorkdir();
  try {
    const result = await execFileAsync('git', args, {
      cwd: repo,
      encoding: 'utf-8',
      env: {
        ...process.env,
        LC_ALL: 'C',
      },
      timeout: timeoutMs,
      maxBuffer: 1024 * 256,
    });
    return formatGitResult(result);
  } catch (err) {
    if (err instanceof Error && ('stdout' in err || 'stderr' in err)) {
      const errorRecord = err as Error & { stdout?: unknown; stderr?: unknown; code?: unknown };
      return formatGitResult({
        stdout: errorRecord.stdout,
        stderr: errorRecord.stderr,
        status: typeof errorRecord.code === 'number'
          ? errorRecord.code
          : null,
        error: errorRecord,
      });
    }
    return formatGitResult({ error: err instanceof Error ? err : new Error(String(err)) });
  }
}

function resolveGhWorkdir(cwd?: string) {
  return cwd?.trim() ? resolveUserPath(cwd.trim()) : getLocalToolsWorkdir();
}

async function executeGh(args: string[], cwd?: string) {
  const repo = resolveGhWorkdir(cwd);
  let result: GitCommandResult;
  try {
    result = await execFileAsync('gh', args, {
      cwd: repo,
      encoding: 'utf-8',
      timeout: 20_000,
      maxBuffer: MAX_GH_BUFFER_BYTES,
    });
  } catch (err) {
    throw formatGhError(err);
  }

  return result;
}

async function runGh(args: string[], cwd?: string, emptyOutput?: string) {
  const result = await executeGh(args, cwd);

  const output = formatGitResult(result);
  if (output === '(no output)') {
    if (emptyOutput !== undefined) return emptyOutput;
    throw new Error('gh command returned no output');
  }
  return output;
}

async function runGhJson(args: string[], cwd?: string) {
  const result = await executeGh(args, cwd);
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

async function resolveGhIssueTarget(issue: string, cwd?: string): Promise<ResolvedGhIssueTarget> {
  const target = normalizeGhTarget(issue, 'issue');
  const urlTarget = parseGhIssueUrl(target);
  if (urlTarget) return urlTarget;
  if (!/^\d+$/.test(target)) {
    throw new Error('issue must be an issue number or URL');
  }

  const repository = readRecord(await runGhJson([
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

async function loadGhIssue(issue: string, cwd?: string) {
  const target = await resolveGhIssueTarget(issue, cwd);
  const issueEndpoint = `repos/${target.repository}/issues/${target.issueNumber}`;
  const issueRecord = readRecord(await runGhJson(ghApiArgs(target, issueEndpoint), cwd));
  if (!issueRecord) throw new Error('gh issue response was not an object');
  return { target, issueEndpoint, issue: issueRecord };
}

function ghContentRoot(cwd?: string) {
  return resolve(resolveGhWorkdir(cwd), '.pinpawo', 'tmp', 'gh');
}

function resolveGhContentPath(path: string, cwd?: string) {
  const root = ghContentRoot(cwd);
  const filePath = resolveUserPath(path);
  const relativePath = relative(root, filePath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`gh_read_content only reads files under ${root}`);
  }
  return filePath;
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

async function viewGhIssue(input: { cwd?: string; issue: string }) {
  const { target, issue } = await loadGhIssue(input.issue, input.cwd);

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

async function viewGhIssueComments(input: {
  cwd?: string;
  issue: string;
  page: number;
  perPage: number;
}) {
  const { target, issueEndpoint, issue } = await loadGhIssue(input.issue, input.cwd);
  const totalComments = typeof issue.comments === 'number' ? issue.comments : 0;
  const commentsEndpoint = `${issueEndpoint}/comments?per_page=${input.perPage}&page=${input.page}`;
  const rawComments = totalComments > 0
    ? await runGhJson(ghApiArgs(target, commentsEndpoint), input.cwd)
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

const gitPathspecSchema = z.array(z.string().min(1)).optional();

export const gitStatusTool = tool(
  async ({ cwd, short = true }: { cwd?: string; short?: boolean }) =>
    runGit(['status', short ? '--short' : '--branch'], cwd),
  {
    name: 'git_status',
    description: '查看当前 git 仓库状态。默认返回短格式；cwd 可指定仓库目录，默认当前 workdir。',
    schema: z.object({
      cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
      short: z.boolean().optional().describe('是否使用 git status --short，默认 true'),
    }),
  },
);

export const gitDiffTool = tool(
  async ({ cwd, pathspecs, staged = false, stat = false }: {
    cwd?: string;
    pathspecs?: string[];
    staged?: boolean;
    stat?: boolean;
  }) => {
    const args = ['diff'];
    if (staged) args.push('--staged');
    if (stat) args.push('--stat');
    const paths = normalizePathspecs(pathspecs);
    if (paths.length > 0) args.push('--', ...paths);
    return runGit(args, cwd);
  },
  {
    name: 'git_diff',
    description: '查看工作区或暂存区 diff。支持限制 pathspecs；默认查看未暂存 diff。',
    schema: z.object({
      cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
      pathspecs: gitPathspecSchema.describe('可选路径列表，用于限制 diff 范围'),
      staged: z.boolean().optional().describe('查看暂存区 diff，相当于 git diff --staged'),
      stat: z.boolean().optional().describe('仅返回 diff 统计'),
    }),
  },
);

export const gitLogTool = tool(
  async ({ cwd, maxCount = 10, oneline = true, pathspecs }: {
    cwd?: string;
    maxCount?: number;
    oneline?: boolean;
    pathspecs?: string[];
  }) => {
    const count = Math.max(1, Math.min(50, Math.trunc(maxCount)));
    const args = ['log', `--max-count=${count}`];
    if (oneline) args.push('--oneline', '--decorate');
    const paths = normalizePathspecs(pathspecs);
    if (paths.length > 0) args.push('--', ...paths);
    return runGit(args, cwd);
  },
  {
    name: 'git_log',
    description: '查看 git 提交历史。默认返回最近 10 条 oneline 记录，可按路径过滤。',
    schema: z.object({
      cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
      maxCount: z.number().int().positive().max(50).optional().describe('最多返回提交数，默认 10，最大 50'),
      oneline: z.boolean().optional().describe('是否使用 oneline 输出，默认 true'),
      pathspecs: gitPathspecSchema.describe('可选路径列表，用于限制历史范围'),
    }),
  },
);

export const gitBranchTool = tool(
  async ({ cwd, all = false }: { cwd?: string; all?: boolean }) =>
    runGit(['branch', all ? '--all' : '--list'], cwd),
  {
    name: 'git_branch',
    description: '列出 git 分支。默认列出本地分支；all=true 时包含远端分支。',
    schema: z.object({
      cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
      all: z.boolean().optional().describe('是否包含远端分支'),
    }),
  },
);

export const gitShowTool = tool(
  async ({ cwd, revision = 'HEAD', stat = false }: {
    cwd?: string;
    revision?: string;
    stat?: boolean;
  }) => {
    const args = ['show', '--no-ext-diff'];
    if (stat) args.push('--stat');
    args.push(revision);
    return runGit(args, cwd);
  },
  {
    name: 'git_show',
    description: '查看指定 revision 的提交、对象或 diff。默认 revision=HEAD；输出会截断。',
    schema: z.object({
      cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
      revision: z.string().optional().describe('git revision，例如 HEAD、提交 SHA 或 branch:path'),
      stat: z.boolean().optional().describe('仅返回统计信息'),
    }),
  },
);

export const gitAddTool = tool(
  async ({ cwd, pathspecs }: { cwd?: string; pathspecs: string[] }) => {
    const paths = normalizePathspecs(pathspecs);
    if (paths.length === 0) return 'Error: git_add requires at least one pathspec';
    return runGit(['add', '--', ...paths], cwd);
  },
  {
    name: 'git_add',
    description: '暂存指定文件或路径。必须显式传 pathspecs，不支持隐式 git add .。',
    schema: z.object({
      cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
      pathspecs: z.array(z.string().min(1)).min(1).describe('要暂存的文件或路径列表'),
    }),
  },
);

export const gitCommitTool = tool(
  async ({ cwd, message }: { cwd?: string; message: string }) => {
    const trimmed = message.trim();
    if (!trimmed) return 'Error: git_commit requires a non-empty message';
    return runGit(['commit', '-m', trimmed], cwd);
  },
  {
    name: 'git_commit',
    description: '创建本地 git commit。只支持 -m message；不会 push，也不会自动 add 文件。',
    schema: z.object({
      cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
      message: z.string().min(1).describe('commit message'),
    }),
  },
);

export const gitPushTool = tool(
  async ({
    cwd,
    remote = 'origin',
    refspec = 'HEAD',
    setUpstream = true,
  }: {
    cwd?: string;
    remote?: string;
    refspec?: string;
    setUpstream?: boolean;
  }) => {
    const args = ['-c', 'protocol.ext.allow=never', 'push'];
    if (setUpstream) args.push('--set-upstream');
    args.push('--', remote.trim(), refspec.trim());
    return runGit(args, cwd, GIT_PUSH_TIMEOUT_MS);
  },
  {
    name: 'git_push',
    description: '执行普通、非 force 的 git push。默认将当前 HEAD 推送到 origin 并设置 upstream；不提供 force、删除远端引用、ext command transport 或额外参数入口。',
    schema: z.object({
      cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
      remote: z.string().trim().min(1).optional().describe('远端名称或地址，默认 origin'),
      refspec: z.string().trim().min(1).refine((value) => !value.startsWith('+') && !value.startsWith(':'), {
        message: 'force and delete refspecs are not supported',
      }).optional().describe('要推送的 refspec，默认 HEAD；不支持 force 或删除 refspec'),
      setUpstream: z.boolean().optional().describe('是否设置 upstream，默认 true'),
    }),
  },
);

export const ghPrCreateTool = tool(
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
      return await runGh(args, cwd);
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

export const ghIssueCreateTool = tool(
  async ({ cwd, title, body = '', repository }: {
    cwd?: string;
    title: string;
    body?: string;
    repository?: string;
  }, runtime: ToolRuntime) => {
    try {
      const args = ['issue', 'create', '--title', title.trim(), '--body', body];
      if (repository?.trim()) args.push('--repo', repository.trim());
      return await runGh(args, cwd);
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

export const ghPrViewTool = tool(
  async ({ cwd, pr }: { cwd?: string; pr: string }, runtime: ToolRuntime) => {
    try {
      return await runGh(['pr', 'view', normalizeGhTarget(pr, 'pr')], cwd);
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

export const ghPrCommentsTool = tool(
  async ({ cwd, pr }: { cwd?: string; pr: string }, runtime: ToolRuntime) => {
    try {
      return await runGh(
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

export const ghPrDiffTool = tool(
  async ({ cwd, pr }: { cwd?: string; pr: string }, runtime: ToolRuntime) => {
    try {
      return await runGh(
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

export const ghIssueViewTool = tool(
  async ({ cwd, issue }: { cwd?: string; issue: string }, runtime: ToolRuntime) => {
    try {
      return await viewGhIssue({ cwd, issue });
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

export const ghIssueCommentsTool = tool(
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
      return await viewGhIssueComments({ cwd, issue, page, perPage });
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

export const ghReadContentTool = tool(
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

export const gitTools = [
  gitStatusTool as NamedStructuredTool<'git_status'>,
  gitDiffTool as NamedStructuredTool<'git_diff'>,
  gitLogTool as NamedStructuredTool<'git_log'>,
  gitBranchTool as NamedStructuredTool<'git_branch'>,
  gitShowTool as NamedStructuredTool<'git_show'>,
  gitAddTool as NamedStructuredTool<'git_add'>,
  gitCommitTool as NamedStructuredTool<'git_commit'>,
  gitPushTool as NamedStructuredTool<'git_push'>,
  ghPrCreateTool as NamedStructuredTool<'gh_pr_create'>,
  ghPrViewTool as NamedStructuredTool<'gh_pr_view'>,
  ghPrCommentsTool as NamedStructuredTool<'gh_pr_comments'>,
  ghPrDiffTool as NamedStructuredTool<'gh_pr_diff'>,
  ghIssueCreateTool as NamedStructuredTool<'gh_issue_create'>,
  ghIssueViewTool as NamedStructuredTool<'gh_issue_view'>,
  ghIssueCommentsTool as NamedStructuredTool<'gh_issue_comments'>,
  ghReadContentTool as NamedStructuredTool<'gh_read_content'>,
] as const;

export const gitOperationMetadata = {
  git_status: {
    title: '查看 git 状态',
    summarizeInput: (input) => ({ target: readString(readRecord(input), 'cwd') }),
  },
  git_diff: {
    title: '查看 git diff',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'cwd'),
        details: {
          staged: readBoolean(record, 'staged'),
          stat: readBoolean(record, 'stat'),
        },
      };
    },
  },
  git_log: {
    title: '查看 git 历史',
    summarizeInput: (input) => ({ target: readString(readRecord(input), 'cwd') }),
  },
  git_branch: {
    title: '查看 git 分支',
    summarizeInput: (input) => ({ target: readString(readRecord(input), 'cwd') }),
  },
  git_show: {
    title: '查看 git 对象',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'revision') ?? readString(record, 'cwd'),
      };
    },
  },
  git_add: {
    title: '暂存 git 文件',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'cwd'),
        summary: normalizePathspecs(Array.isArray(record?.pathspecs)
          ? record.pathspecs.filter((item): item is string => typeof item === 'string')
          : undefined).join(' '),
      };
    },
  },
  git_commit: {
    title: '创建 git commit',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'cwd'),
        summary: readString(record, 'message'),
      };
    },
  },
  git_push: {
    title: '推送 git 分支',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'remote') ?? 'origin',
        summary: readString(record, 'refspec') ?? 'HEAD',
        details: {
          setUpstream: readBoolean(record, 'setUpstream') ?? true,
        },
      };
    },
  },
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
} satisfies Record<(typeof gitTools)[number]['name'], ToolOperationMetadata>;
