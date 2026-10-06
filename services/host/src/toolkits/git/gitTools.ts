import { tool, type ToolRuntime } from '@langchain/core/tools';
import type { NamedStructuredTool, ToolOperationMetadata } from '@pinpawo/pet-agent';
import { createAbortError } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { readBoolean, readRecord, readString } from '../operationMetadata';
import {
  CLI_SHELL_TIMEOUT_MS,
  cliArgsSchema,
  createCliRunner,
  formatCliResult,
  readCliArgs,
  summarizeCliCall,
  toError,
  type CliRunner,
} from '../cli/cliRunner';
import type { ShellExecResult, ShellRS } from '../shellRS/shellRS';
import { classifyGitArgs } from './gitCommands';

const DEFAULT_GIT_TIMEOUT_MS = 15_000;
const GIT_PUSH_TIMEOUT_MS = 120_000;
const MAX_GIT_CAPTURE_CHARS = 1024 * 256;
/**
 * Non-interactive by construction: a command that would open an editor or a
 * credential prompt fails instead of hanging until the timeout.
 */
const GIT_SHELL_ENV = { GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false', GIT_TERMINAL_PROMPT: '0' };

function normalizePathspecs(pathspecs: string[] | undefined) {
  return Array.isArray(pathspecs)
    ? pathspecs.map((item) => item.trim()).filter(Boolean)
    : [];
}

export async function runGit(
  cli: CliRunner,
  args: string[],
  cwd?: string,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  env: Readonly<Record<string, string>> = {},
) {
  const repo = cwd?.trim() || process.cwd();
  let result: ShellExecResult;
  try {
    result = await cli(['git', ...args], {
      cwd: repo,
      env: { LC_ALL: 'C', ...env },
      timeoutMs,
      maxOutputChars: MAX_GIT_CAPTURE_CHARS,
    });
  } catch (err) {
    return formatCliResult({ error: toError(err) });
  }
  switch (result.status) {
    case 'exited':
      // Only exit code 0 is success. A null code means the process was ended
      // by a signal, which is a failure even with no output.
      return formatCliResult({
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.code,
        ...(result.code === null
          ? { error: new Error(`git ${args[0] ?? ''} was terminated by a signal`) }
          : {}),
      });
    case 'timeout':
      return formatCliResult({
        stdout: result.stdout,
        stderr: result.stderr,
        error: new Error(`git ${args[0] ?? ''} timed out after ${(timeoutMs / 1000).toString()}s`),
      });
    case 'aborted':
      throw createAbortError();
    case 'spawn_failed':
      return formatCliResult({ error: result.error });
    case 'yielded':
      return formatCliResult({ error: new Error('git command unexpectedly kept running') });
  }
}

const gitPathspecSchema = z.array(z.string().min(1)).optional();

/** Only risky git_shell calls are reviewed; reads and everyday writes run directly. */
export function gitShellCallNeedsReview(input: unknown) {
  return classifyGitArgs(readCliArgs(input)).level === 'risky';
}

/** Local git tools, running every invocation as argv through the injected ShellRS. */
export function createGitTools(shell: ShellRS) {
  const cliFor = (runtime: ToolRuntime) => createCliRunner(shell, runtime);

  const gitStatusTool = tool(
    async ({ cwd, short = true }: { cwd?: string; short?: boolean }, runtime: ToolRuntime) =>
      runGit(cliFor(runtime), ['status', short ? '--short' : '--branch'], cwd),
    {
      name: 'git_status',
      description: '查看当前 git 仓库状态。默认返回短格式；cwd 可指定仓库目录，默认当前 workdir。',
      schema: z.object({
        cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
        short: z.boolean().optional().describe('是否使用 git status --short，默认 true'),
      }),
    },
  );

  const gitDiffTool = tool(
    async ({ cwd, pathspecs, staged = false, stat = false }: {
      cwd?: string;
      pathspecs?: string[];
      staged?: boolean;
      stat?: boolean;
    }, runtime: ToolRuntime) => {
      const args = ['diff'];
      if (staged) args.push('--staged');
      if (stat) args.push('--stat');
      const paths = normalizePathspecs(pathspecs);
      if (paths.length > 0) args.push('--', ...paths);
      return runGit(cliFor(runtime), args, cwd);
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

  const gitLogTool = tool(
    async ({ cwd, maxCount = 10, oneline = true, pathspecs }: {
      cwd?: string;
      maxCount?: number;
      oneline?: boolean;
      pathspecs?: string[];
    }, runtime: ToolRuntime) => {
      const count = Math.max(1, Math.min(50, Math.trunc(maxCount)));
      const args = ['log', `--max-count=${count}`];
      if (oneline) args.push('--oneline', '--decorate');
      const paths = normalizePathspecs(pathspecs);
      if (paths.length > 0) args.push('--', ...paths);
      return runGit(cliFor(runtime), args, cwd);
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

  const gitBranchTool = tool(
    async ({ cwd, all = false }: { cwd?: string; all?: boolean }, runtime: ToolRuntime) =>
      runGit(cliFor(runtime), ['branch', all ? '--all' : '--list'], cwd),
    {
      name: 'git_branch',
      description: '列出 git 分支。默认列出本地分支；all=true 时包含远端分支。',
      schema: z.object({
        cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
        all: z.boolean().optional().describe('是否包含远端分支'),
      }),
    },
  );

  const gitShowTool = tool(
    async ({ cwd, revision = 'HEAD', stat = false }: {
      cwd?: string;
      revision?: string;
      stat?: boolean;
    }, runtime: ToolRuntime) => {
      const args = ['show', '--no-ext-diff'];
      if (stat) args.push('--stat');
      args.push(revision);
      return runGit(cliFor(runtime), args, cwd);
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

  const gitAddTool = tool(
    async ({ cwd, pathspecs }: { cwd?: string; pathspecs: string[] }, runtime: ToolRuntime) => {
      const paths = normalizePathspecs(pathspecs);
      if (paths.length === 0) return 'Error: git_add requires at least one pathspec';
      return runGit(cliFor(runtime), ['add', '--', ...paths], cwd);
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

  const gitCommitTool = tool(
    async ({ cwd, message }: { cwd?: string; message: string }, runtime: ToolRuntime) => {
      const trimmed = message.trim();
      if (!trimmed) return 'Error: git_commit requires a non-empty message';
      return runGit(cliFor(runtime), ['commit', '-m', trimmed], cwd);
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

  const gitPushTool = tool(
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
    }, runtime: ToolRuntime) => {
      const args = ['-c', 'protocol.ext.allow=never', 'push'];
      if (setUpstream) args.push('--set-upstream');
      args.push('--', remote.trim(), refspec.trim());
      return runGit(cliFor(runtime), args, cwd, GIT_PUSH_TIMEOUT_MS);
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

  const gitShellTool = tool(
    async ({ cwd, args }: { cwd?: string; args: string[] }, runtime: ToolRuntime) =>
      runGit(cliFor(runtime), args, cwd, CLI_SHELL_TIMEOUT_MS, GIT_SHELL_ENV),
    {
      name: 'git_shell',
      description: '执行一条 git 命令，用于 git_* 专用工具没有覆盖的操作。直接以参数数组执行，不经 shell：不支持管道、重定向或 && 串联；需要配合管道的只读查询用 inspect_shell。'
        + '查询和日常操作（commit、checkout/switch 分支、stash、fetch、pull、merge、rebase、普通 push 等）直接执行。'
        + '会丢数据或改写共享历史的操作要审批：reset --hard、clean、checkout/restore 覆盖改动、stash drop/clear、强制删除分支、删除标签、强推或删除远端引用。这类操作确是任务需要时再做，执行前先用 git status / git log 看清影响；能保留数据时优先用可恢复的做法（先 stash；强推用 --force-with-lease）。被拒绝后不要换工具绕过。'
        + '不会打开编辑器或凭据提示：rebase -i、不带 -m 的 commit 这类需要交互的命令会直接失败。仓库目录用 cwd 指定，不要用 -c 注入配置。超时 120 秒。',
      schema: z.object({
        cwd: z.string().optional().describe('仓库目录；默认当前 workdir'),
        args: cliArgsSchema('git', '["reset", "--hard", "HEAD"]'),
      }),
    },
  );

  const gitTools = [
    gitStatusTool as NamedStructuredTool<'git_status'>,
    gitDiffTool as NamedStructuredTool<'git_diff'>,
    gitLogTool as NamedStructuredTool<'git_log'>,
    gitBranchTool as NamedStructuredTool<'git_branch'>,
    gitShowTool as NamedStructuredTool<'git_show'>,
    gitAddTool as NamedStructuredTool<'git_add'>,
    gitCommitTool as NamedStructuredTool<'git_commit'>,
    gitPushTool as NamedStructuredTool<'git_push'>,
    gitShellTool as NamedStructuredTool<'git_shell'>,
  ] as const;

  /** The read-only subset, composed into project-inspection. */
  const gitInspectionTools = [
    gitStatusTool as NamedStructuredTool<'git_status'>,
    gitDiffTool as NamedStructuredTool<'git_diff'>,
    gitLogTool as NamedStructuredTool<'git_log'>,
    gitBranchTool as NamedStructuredTool<'git_branch'>,
    gitShowTool as NamedStructuredTool<'git_show'>,
  ] as const;

  return { gitTools, gitInspectionTools };
}

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
  git_shell: {
    title: '执行 git 命令',
    summarizeInput: (input) => summarizeCliCall('git', input, classifyGitArgs),
  },
} satisfies Record<
  ReturnType<typeof createGitTools>['gitTools'][number]['name'],
  ToolOperationMetadata
>;
