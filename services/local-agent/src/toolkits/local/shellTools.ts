import { tool, type ToolRuntime } from '@langchain/core/tools';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { createAbortError, type ToolOperationMetadata } from '@pinpawo/pet-agent';
import { readRecord, readString } from '../operationMetadata';
import { shellInvocation, type ShellResult } from './shellClient';
import { classifyReadOnlyShellCommand } from './readOnlyShell';


function readShellActionInput(input: unknown) {
  if (!input || typeof input !== 'object') {
    throw new Error('run_shell requires a command');
  }
  const record = input as Record<string, unknown>;
  const command = typeof record.command === 'string' && record.command.trim()
    ? record.command.trim()
    : null;
  if (!command) {
    throw new Error('run_shell requires a command');
  }
  return { record, command };
}

export function normalizeShellAuthorizationInput(input: unknown) {
  const { record, command } = readShellActionInput(input);
  const cwd = typeof record.cwd === 'string' && record.cwd.trim()
    ? record.cwd
    : null;
  return { command, cwd };
}

export function normalizeShellActionInput(input: unknown) {
  const { record, command } = readShellActionInput(input);
  const cwd = typeof record.cwd === 'string' && record.cwd.trim()
    ? record.cwd
    : null;
  if (!cwd || !isAbsolute(cwd)) throw new Error('Shell cwd must be an absolute path prepared before review.');
  return { command, cwd };
}

const DEFAULT_SHELL_TIMEOUT_SECONDS = 60;
const MAX_SHELL_TIMEOUT_SECONDS = 600;
const SHELL_MAX_CAPTURE_CHARS = 4 * 1024 * 1024;
const SHELL_OUTPUT_LIMIT_CHARS = 20_000;

function resolveCurrentTimezone(timezone?: string) {
  const trimmed = timezone?.trim();
  return trimmed || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function buildCurrentTimeSnapshot(now = new Date(), timezone?: string) {
  const resolvedTimezone = resolveCurrentTimezone(timezone);
  const localTime = new Intl.DateTimeFormat('sv-SE', {
    timeZone: resolvedTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);

  return {
    iso: now.toISOString(),
    timezone: resolvedTimezone,
    localTime,
    unixMs: now.getTime(),
    unixSeconds: Math.floor(now.getTime() / 1000),
  };
}

export function truncateShellOutput(output: string, limit = SHELL_OUTPUT_LIMIT_CHARS) {
  if (output.length <= limit) {
    return output;
  }
  const headLength = Math.floor(limit * 0.7);
  const tailLength = limit - headLength;
  const omitted = output.length - headLength - tailLength;
  return `${output.slice(0, headLength)}\n[... truncated ${omitted.toString()} chars ...]\n${output.slice(output.length - tailLength)}`;
}

function resolveShellTimeoutMs(timeoutSeconds: number | undefined) {
  const seconds = Math.min(
    Math.max(1, Math.floor(timeoutSeconds ?? DEFAULT_SHELL_TIMEOUT_SECONDS)),
    MAX_SHELL_TIMEOUT_SECONDS,
  );
  return seconds * 1000;
}

export const getCurrentTimeTool = tool(
  async (input: { timezone?: string } = {}) => {
    try {
      return JSON.stringify(buildCurrentTimeSnapshot(new Date(), input.timezone), null, 2);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'get_current_time',
    description: '查询当前系统时间。回答“现在”“今天”“昨天”等相对时间问题时优先使用本工具，不要用 run_shell 包装 date 命令。默认返回本机时区下的时间，也可传 IANA timezone（例如 Asia/Shanghai）指定时区。',
    schema: z.object({
      timezone: z.string().optional().describe('可选 IANA 时区名，例如 Asia/Shanghai；省略时使用本机默认时区'),
    }),
  },
);

export function createRunShellTool(
  /**
   * Builds the tool under a different identity with an admission check in
   * front. `inspect_shell` is the same executor as `run_shell`; building it
   * here rather than delegating through `run_shell.invoke()` is what keeps its
   * lifecycle events reported under its own name.
   */
  variant?: {
    name: string;
    description: string;
    admit: (command: string) => { allowed: true } | { allowed: false; reason: string };
  },
) {
  return tool(
    async (
      input: { command: string; cwd?: string; timeoutSeconds?: number },
      runtime: ToolRuntime,
    ) => {
      let shellAction: { command: string; cwd: string };

      try {
        shellAction = normalizeShellActionInput(input);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : err}`;
      }

      if (variant) {
        const verdict = variant.admit(shellAction.command);
        if (!verdict.allowed) {
          return `Error: ${variant.name} 只接受可静态判定为只读的命令（${verdict.reason}）。`
            + '需要执行该命令时改用 run_shell，它会走工具审批。';
        }
      }

      const timeoutMs = resolveShellTimeoutMs(input.timeoutSeconds);
      const scope = shellInvocation(runtime);
      const outcome = await scope.client.run({
        command: shellAction.command,
        cwd: shellAction.cwd,
        timeoutMs,
        maxOutputChars: SHELL_MAX_CAPTURE_CHARS,
      }, scope);

      if (outcome.status === 'spawn_failed') {
        return `Error: ${outcome.error.message}`;
      }

      // Cancellation is not a result. Let it propagate so the graph unwinds
      // instead of feeding the model a string that reads like a failure.
      if (outcome.status === 'aborted') {
        throw createAbortError();
      }

      if (outcome.status === 'yielded') {
        return adoptYieldedProcess({
          outcome,
          timeoutMs,
        });
      }

      const out = truncateShellOutput(outcome.stdout.trimEnd());
      const err = truncateShellOutput(outcome.stderr.trimEnd());

      if (outcome.status === 'timeout' || outcome.status === 'output_limit') {
        const output = [err, out].filter(Boolean).join('\n');
        return [
          `Error: command timed out after ${(timeoutMs / 1000).toString()}s`,
          'and was terminated along with its child processes.',
          'If it needs longer and is not waiting for interactive input,'
          + ' retry with a larger timeoutSeconds.',
          output,
        ].filter(Boolean).join('\n').trimEnd();
      }

      if (outcome.status !== 'exited') throw new Error(`Unexpected Shell result: ${outcome.status}`);
      if (outcome.code !== 0) {
        const output = [err, out].filter(Boolean).join('\n');
        const exitCode = outcome.code === null ? '?' : outcome.code.toString();
        return `Error (exit ${exitCode}):\n${output || '(no output)'}`;
      }

      return [out || '(no output)', err ? `--- stderr ---\n${err}` : '']
        .filter(Boolean)
        .join('\n');
    },
    {
      name: variant?.name ?? 'run_shell',
      description: variant?.description ?? '兜底工具：异步执行非交互 shell 命令并返回输出，每次调用都要经过工具审批，因此明显慢于 inspect_shell。命令如果只是查看而不修改任何状态（grep、sed -n、cat、ls、find、wc、git log/status/diff 等，可含 cd 与管道），改用 inspect_shell，不要用本工具。只有确实会写入、安装、删除、推送，或需要重定向、heredoc、bash -c/node -e 这类内联执行时才用它。只有没有更具体的专用工具覆盖时才使用；不要用它替代 view_file_chunk/read_file/jq_query/write_file/apply_patch/move_path/copy_path/mkdir_path/list_dir/glob_search/grep_search/http_fetch/download_file。默认在当前 workdir 执行，相对路径也默认相对于该目录；如有需要可显式传 cwd 覆盖。支持命令自身携带内容的 heredoc 和输出重定向，写入效果仍受 toolkit 审批约束。默认超时 60s，可通过 timeoutSeconds 调整（上限 600s）；输出过长时保留开头和结尾并标注截断。命令在超时后不会被中止，而是转入后台并返回一个进程 id，用 wait_process 继续跟进、terminate_process 终止；因此无需为构建、安装、测试等慢命令预先调大超时，也不要因为超时就重复执行同一命令。不要用于需要交互输入或全屏 TTY 的命令。命令会先进入 toolkit 审批，可批准、拒绝或给出新的处理方向。',
      schema: z.object({
        command: z.string().describe('要执行的 shell 命令'),
        cwd: z.string().optional().describe('命令执行目录；默认当前 workdir'),
        timeoutSeconds: z.number().int().positive().optional().describe('等待多少秒后转入后台；默认 60，上限 600'),
      }),
    },
  );
}

/**
 * Present a service-owned running command and tell the model how
 * to follow it.
 *
 * A timed-out command is slow, not failed. Reporting failure is what led a
 * model to rerun `pnpm install` while the first one was still writing to the
 * same node_modules, so the wording here deliberately frames the process as
 * ongoing work with a handle rather than an error.
 */
function adoptYieldedProcess(params: {
  outcome: ShellResult & { status: 'yielded' };
  timeoutMs: number;
}) {
  const { outcome, timeoutMs } = params;
  const seconds = (timeoutMs / 1000).toString();

  const out = truncateShellOutput(outcome.stdout.trimEnd());
  const err = truncateShellOutput(outcome.stderr.trimEnd());
  const output = [
    out || '(no output yet)',
    err ? `--- stderr ---\n${err}` : '',
  ].filter(Boolean).join('\n');

  return [
    `Command is still running after ${seconds}s and moved to the background.`,
    `Process id: ${outcome.processId}`,
    `Use wait_process to follow it, or terminate_process to stop it.`,
    'Do not rerun the same command; it is still in progress.',
    output,
  ].join('\n');
}

/**
 * Read-only shell, admitted by rule instead of by review.
 *
 * `run_shell` costs a model-driven review on every call, and most of what an
 * agent actually runs is inspection — `cd x && grep ...`, `git log | head`.
 * This tool carries no review policy, so `classifyReadOnlyShellCommand` is the
 * whole safety boundary: anything it does not positively recognise as
 * read-only is refused and the agent falls back to `run_shell`.
 */
export function createInspectShellTool() {
  return createRunShellTool({
    name: 'inspect_shell',
    description: '只读 shell：执行不会修改任何状态的检查类命令，无需审批，因此比 run_shell 快得多，应作为查看类命令的默认选择。支持 cd、管道与 && 串联，例如 `cd src && grep -rn "foo" . | head -20`。只接受白名单内的只读命令（cat/head/tail/ls/find/grep/rg/sed -n/awk/cut/sort/uniq/wc/jq/diff/stat/file/env/date/git log|status|diff|show|branch|blame|rev-parse 等）；不支持输出重定向、命令替换、heredoc、后台执行，也不支持 bash -c、node -e、python -c 这类内联执行。任何写入、安装、删除、推送或不在白名单内的命令都要改用 run_shell。默认在当前 workdir 执行，可传 cwd 覆盖。',
    admit: classifyReadOnlyShellCommand,
  });
}

export const runShellTool = createRunShellTool();
export const inspectShellTool = createInspectShellTool();

export const shellOperationMetadata: Record<string, ToolOperationMetadata> = {
  get_current_time: {
    title: '查询时间',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'timezone'),
      };
    },
  },
  run_shell: {
    title: '执行命令',
    summarizeInput: (input) => {
      const shellAction = normalizeShellAuthorizationInput(input);
      return {
        target: shellAction.cwd ?? undefined,
        summary: shellAction.command,
      };
    },
  },
  inspect_shell: {
    title: '只读命令',
    summarizeInput: (input) => {
      const shellAction = normalizeShellAuthorizationInput(input);
      return {
        target: shellAction.cwd ?? undefined,
        summary: shellAction.command,
      };
    },
  },
};
