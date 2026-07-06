import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from '@langchain/core/tools';
import {
  type NamedStructuredTool,
  type ToolOperationMetadataMapFor,
} from '@pinpawo/pet-agent';
import { z } from 'zod';
import { getCurrentLocalAgentInterface } from '../../chatInterface';
import { readBoolean, readRecord, readString } from '../operationMetadata';
import { getLocalToolsWorkdir, resolveUserPath } from './pathUtils';

const MAX_GIT_OUTPUT_CHARS = 30_000;
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

export async function runGit(args: string[], cwd?: string) {
  const repo = cwd?.trim() ? resolveUserPath(cwd.trim()) : getLocalToolsWorkdir();
  try {
    const result = await execFileAsync('git', args, {
      cwd: repo,
      encoding: 'utf-8',
      timeout: 15_000,
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

async function runGh(args: string[], cwd?: string) {
  const repo = cwd?.trim() ? resolveUserPath(cwd.trim()) : getLocalToolsWorkdir();
  try {
    const result = await execFileAsync('gh', args, {
      cwd: repo,
      encoding: 'utf-8',
      timeout: 20_000,
      maxBuffer: 1024 * 512,
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

    const { capabilities } = getCurrentLocalAgentInterface();
    if (!capabilities.humanReview) {
      return 'Error: git_commit requires human review before execution.';
    }

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

export const ghPrViewTool = tool(
  async ({ cwd, pr }: { cwd?: string; pr: string }) =>
    runGh(['pr', 'view', normalizeGhTarget(pr, 'pr'), '--comments'], cwd),
  {
    name: 'gh_pr_view',
    description: '使用 GitHub CLI 查看 PR 元数据、描述、review 和评论。pr 可为 PR 编号、URL 或分支名；默认当前 workdir 仓库。',
    schema: z.object({
      cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
      pr: z.string().min(1).describe('PR 编号、URL 或分支名'),
    }),
  },
);

export const ghPrDiffTool = tool(
  async ({ cwd, pr }: { cwd?: string; pr: string }) =>
    runGh(['pr', 'diff', normalizeGhTarget(pr, 'pr'), '--patch'], cwd),
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
  async ({ cwd, issue }: { cwd?: string; issue: string }) =>
    runGh(['issue', 'view', normalizeGhTarget(issue, 'issue'), '--comments'], cwd),
  {
    name: 'gh_issue_view',
    description: '使用 GitHub CLI 查看 issue 元数据、描述和评论。issue 可为 issue 编号或 URL；默认当前 workdir 仓库。',
    schema: z.object({
      cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
      issue: z.string().min(1).describe('Issue 编号或 URL'),
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
  ghPrViewTool as NamedStructuredTool<'gh_pr_view'>,
  ghPrDiffTool as NamedStructuredTool<'gh_pr_diff'>,
  ghIssueViewTool as NamedStructuredTool<'gh_issue_view'>,
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
  gh_pr_view: {
    title: '查看 GitHub PR',
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
  gh_issue_view: {
    title: '查看 GitHub issue',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'issue') ?? readString(record, 'cwd'),
      };
    },
  },
} satisfies ToolOperationMetadataMapFor<typeof gitTools>;
