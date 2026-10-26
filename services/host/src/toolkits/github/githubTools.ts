import { ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { createAbortError, type NamedStructuredTool, type ToolOperationMetadata } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { readBoolean, readRecord, readString } from '../operationMetadata';
import {
  createCliRunner,
  formatCliResult,
  truncateCliOutput,
  type CliCommandResult,
  type CliRunner,
} from '../cli/cliRunner';
import type { ShellExecResult, ShellRS } from '../shellRS/shellRS';

const MAX_GH_BUFFER_BYTES = 1024 * 1024 * 4;
const GH_TIMEOUT_MS = 20_000;
/** Prompts disabled: a command missing a required flag fails instead of hanging. */
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0' };

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

async function executeGh(cli: CliRunner, args: string[], cwd?: string) {
  const repo = resolveGhWorkdir(cwd);
  const timeoutMs = GH_TIMEOUT_MS;
  let result: ShellExecResult;
  try {
    result = await cli(['gh', ...args], {
      cwd: repo,
      timeoutMs,
      maxOutputChars: MAX_GH_BUFFER_BYTES,
      env: GH_ENV,
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

async function runGh(cli: CliRunner, args: string[], cwd?: string) {
  const output = formatCliResult(await executeGh(cli, args, cwd));
  if (output === '(no output)') throw new Error('gh command returned no output');
  return output;
}

/** GitHub tools whose long free-text input is clumsy to quote on a shell command line. */
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

  const githubTools = [
    ghPrCreateTool as NamedStructuredTool<'gh_pr_create'>,
    ghIssueCreateTool as NamedStructuredTool<'gh_issue_create'>,
  ] as const;

  return { githubTools };
}

export const githubOperationMetadata = {
  gh_pr_create: {
    title: '创建 GitHub PR',
    summarize: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'repository') ?? readString(record, 'base') ?? readString(record, 'cwd'),
        summary: `${readString(record, 'title') ?? '创建 PR'}${readBoolean(record, 'draft') ? '（草稿）' : ''}`,
        ...(readString(record, 'body') ? { blocks: [{ kind: 'text', label: '描述', text: readString(record, 'body')! }] } : {}),
      };
    },
  },
  gh_issue_create: {
    title: '创建 GitHub issue',
    summarize: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'repository') ?? readString(record, 'cwd'),
        summary: readString(record, 'title'),
      };
    },
  },
} satisfies Record<
  ReturnType<typeof createGithubTools>['githubTools'][number]['name'],
  ToolOperationMetadata
>;
