import { tool, type ToolRuntime } from '@langchain/core/tools';
import type { NamedStructuredTool, ToolOperationMetadata } from '@pinpawo/pet-agent';
import { createAbortError } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { readBoolean, readRecord, readString } from '../operationMetadata';
import { createCliRunner, formatCliResult, type CliRunner } from '../cli/cliRunner';
import type { ShellExecResult, ShellRS } from '../shellRS/shellRS';

const DEFAULT_GIT_TIMEOUT_MS = 15_000;
const GIT_PUSH_TIMEOUT_MS = 120_000;
const MAX_GIT_CAPTURE_CHARS = 1024 * 256;
/**
 * Non-interactive by construction: a command that would open an editor or a
 * credential prompt fails instead of hanging until the timeout.
 */
const GIT_ENV = { GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false', GIT_TERMINAL_PROMPT: '0' };

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
) {
  const repo = cwd?.trim() || process.cwd();
  let result: ShellExecResult;
  try {
    result = await cli(['git', ...args], {
      cwd: repo,
      env: { LC_ALL: 'C', ...GIT_ENV },
      timeoutMs,
      maxOutputChars: MAX_GIT_CAPTURE_CHARS,
    });
  } catch (err) {
    return formatCliResult({ error: err instanceof Error ? err : new Error(String(err)) });
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

/**
 * Everyday git writes whose schema cannot express a dangerous form: explicit
 * pathspecs only, `commit -m` only, and push without force or deletion. They
 * run unreviewed; every other git write goes through run_shell and review.
 */
export function createGitTools(shell: ShellRS) {
  const cliFor = (runtime: ToolRuntime) => createCliRunner(shell, runtime);

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

  return [
    gitAddTool as NamedStructuredTool<'git_add'>,
    gitCommitTool as NamedStructuredTool<'git_commit'>,
    gitPushTool as NamedStructuredTool<'git_push'>,
  ] as const;
}

export const gitOperationMetadata = {
  git_add: {
    title: '暂存 git 文件',
    summarize: (input) => {
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
    summarize: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'cwd'),
        summary: readString(record, 'message'),
      };
    },
  },
  git_push: {
    title: '推送 git 分支',
    summarize: (input) => {
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
} satisfies Record<
  ReturnType<typeof createGitTools>[number]['name'],
  ToolOperationMetadata
>;
