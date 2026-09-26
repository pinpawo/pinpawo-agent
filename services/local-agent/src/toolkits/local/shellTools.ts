import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { createAbortError, type ToolOperationMetadata } from '@pinpawo/pet-agent';
import { readRecord, readString } from '../operationMetadata';
import { requireAgentSession } from './executionContext';
import { classifyReadOnlyShellCommand } from './readOnlyShell';
import { ShellRSError, type ShellExecResult, type ShellRS } from './shellRS';


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
    ? record.cwd.trim()
    : null;
  return { command, cwd };
}

export function normalizeShellActionInput(input: unknown) {
  const { record, command } = readShellActionInput(input);
  const cwd = typeof record.cwd === 'string' && record.cwd.trim()
    ? record.cwd.trim()
    : process.cwd();
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
  shell: ShellRS,
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
      let outcome: ShellExecResult;
      try {
        outcome = await shell.exec(requireAgentSession(runtime), {
          command: { shell: shellAction.command },
          cwd: shellAction.cwd,
          waitMs: timeoutMs,
          onTimeout: 'terminate',
          maxOutputChars: SHELL_MAX_CAPTURE_CHARS,
          ...(runtime.signal ? { signal: runtime.signal } : {}),
        });
      } catch (err) {
        return formatShellError(err);
      }

      if (outcome.status === 'spawn_failed') {
        return `Error: ${outcome.error.message}`;
      }

      // Cancellation is not a result. Let it propagate so the graph unwinds
      // instead of feeding the model a string that reads like a failure.
      if (outcome.status === 'aborted') {
        throw createAbortError();
      }

      if (outcome.status === 'yielded') {
        return JSON.stringify({
          status: 'error',
          code: 'unexpected_yield',
          processId: outcome.process.processId,
          message: 'The command is still running unexpectedly. Inspect or terminate this process; do not rerun it.',
        });
      }

      const out = truncateShellOutput(outcome.stdout.trimEnd());
      const err = truncateShellOutput(outcome.stderr.trimEnd());

      if (outcome.status === 'timeout') {
        return JSON.stringify({
          status: 'timeout',
          termination: outcome.termination ?? 'unconfirmed',
          timeoutSeconds: timeoutMs / 1000,
          stdout: out,
          stderr: err,
          message: outcome.termination === 'confirmed'
            ? 'The command exceeded its time limit and its POSIX process group was terminated. '
              + 'Side effects were not rolled back. Check existing results before using start_process for a long task.'
            : 'The command exceeded its time limit, but process group termination could not be confirmed. '
              + 'Check whether work is still running before retrying; do not start a duplicate task.',
        });
      }

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
      description: variant?.description ?? '短命令兜底工具：执行有时限的非交互 shell 命令并等待结果，每次调用都要经过工具审批，因此明显慢于 inspect_shell。命令如果只是查看而不修改任何状态（grep、sed -n、cat、ls、find、wc、git log/status/diff 等，可含 cd 与管道），改用 inspect_shell，不要用本工具。只有确实会写入、安装、删除、推送，或需要重定向、heredoc、bash -c/node -e 这类内联执行时才用它。只有没有更具体的专用工具覆盖时才使用；不要用它替代 view_file_chunk/read_file/write_file/apply_patch/move_path/copy_path/mkdir_path/list_dir/http_fetch/download_file；搜索代码（rg）和查询 JSON（jq）用 inspect_shell。默认在当前 workdir 执行，相对路径也默认相对于该目录；如有需要可显式传 cwd 覆盖。支持命令自身携带内容的 heredoc 和输出重定向，写入效果仍受 toolkit 审批约束。默认超时 60s，可通过 timeoutSeconds 调整（上限 600s）；输出过长时保留开头和结尾并标注截断。超时会终止进程组并返回结构化超时结果，不会自动转后台。安装依赖、完整构建、长测试或开发服务器等预计耗时或持续运行的任务用 start_process。超时不回滚已产生的副作用，改用 start_process 前先检查执行结果；终止未确认或结果未知时不要重复启动。不要用于需要交互输入或全屏 TTY 的命令。命令会先进入 toolkit 审批，可批准、拒绝或给出新的处理方向。',
      schema: z.object({
        command: z.string().describe('要执行的 shell 命令'),
        cwd: z.string().optional().describe('命令执行目录；默认当前 workdir'),
        timeoutSeconds: z.number().int().positive().optional().describe('命令执行时限（秒）；超时终止，不转后台；默认 60，上限 600'),
      }),
    },
  );
}

function formatShellError(error: unknown) {
  if (error instanceof ShellRSError) {
    return JSON.stringify({ status: 'error', code: error.code, message: error.message });
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

/** Start a managed task without waiting for it to finish. */
export function createStartProcessTool(shell: ShellRS) {
  return tool(
    async (input: { command: string; cwd?: string }, runtime: ToolRuntime) => {
      let outcome: ShellExecResult;
      try {
        const action = normalizeShellActionInput(input);
        outcome = await shell.exec(requireAgentSession(runtime), {
          command: { shell: action.command },
          cwd: action.cwd,
          waitMs: 0,
          onTimeout: 'yield',
          maxOutputChars: SHELL_MAX_CAPTURE_CHARS,
          ...(runtime.signal ? { signal: runtime.signal } : {}),
        });
      } catch (error) {
        return formatShellError(error);
      }
      if (outcome.status === 'aborted') throw createAbortError();
      if (outcome.status === 'spawn_failed') {
        return JSON.stringify({ status: 'spawn_failed', message: outcome.error.message });
      }
      if (outcome.status === 'yielded') {
        return JSON.stringify({
          status: 'started',
          processId: outcome.process.processId,
          process: outcome.process,
          stdout: truncateShellOutput(outcome.stdout),
          stderr: truncateShellOutput(outcome.stderr),
        });
      }
      // An older service can finish a fast command before its zero-delay
      // yield. Preserve that result; never imply it failed or should be replayed.
      return JSON.stringify(outcome.status === 'exited'
        ? { ...outcome, stdout: truncateShellOutput(outcome.stdout), stderr: truncateShellOutput(outcome.stderr) }
        : { ...outcome, termination: outcome.termination ?? 'unconfirmed',
            stdout: truncateShellOutput(outcome.stdout), stderr: truncateShellOutput(outcome.stderr) });
    },
    {
      name: 'start_process',
      description: '启动非交互长任务，启动成功即返回 processId，不等待完成。安装依赖、完整构建、长测试、开发服务器等用本工具。用 wait_process 读取进展和退出结果、list_processes 找回当前会话任务、terminate_process 停止任务。默认在当前 workdir 执行，可传 cwd 覆盖。任务跨调用和 Host 断连继续运行；不要重复启动同一任务。启动成功不表示命令成功，需查看退出结果。短命令用 run_shell，只读短查询用 inspect_shell。执行前需要命令审核。不支持交互输入或 TTY。',
      schema: z.object({
        command: z.string().min(1).describe('要启动的 shell 命令；直接运行，不要加 & 或 nohup 脱离管理'),
        cwd: z.string().optional().describe('命令执行目录；默认当前 workdir'),
      }),
    },
  );
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
export function createInspectShellTool(shell: ShellRS) {
  return createRunShellTool(shell, {
    name: 'inspect_shell',
    description: '只读 shell：执行不会修改任何状态的检查类命令，无需审批，因此比 run_shell 快得多，应作为查看类命令的默认选择。支持 cd、管道与 && 串联，例如 `cd src && rg -n "foo" | head -20`。搜索代码和文件优先用 rg：`rg -n "pattern" [path]` 搜内容（加 -F 按字面匹配、-i 忽略大小写、-C 2 带上下文、-g "*.ts" 限定文件），`rg --files -g "*.ts"` 按文件名找文件，`rg -l` 只列文件名；rg 默认遵守 .gitignore、排除 .pinpawo、截断超长行。查 JSON 用 jq，例如 `jq ".scripts" package.json`。只接受白名单内的只读命令（cat/head/tail/ls/find/grep/rg/sed -n/awk/cut/sort/uniq/wc/jq/diff/stat/file/env/date/git log|status|diff|show|branch|blame|rev-parse 等）；不支持输出重定向、命令替换、heredoc、后台执行，也不支持 bash -c、node -e、python -c 这类内联执行。任何写入、安装、删除、推送或不在白名单内的命令都要改用 run_shell。默认在当前 workdir 执行，可传 cwd 覆盖。执行超时会终止进程组，不转后台；预计耗时的任务用需要审批的 start_process。',
    admit: classifyReadOnlyShellCommand,
  });
}

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
  start_process: {
    title: '启动长任务',
    summarizeInput: (input) => {
      const action = normalizeShellAuthorizationInput(input);
      return { target: action.cwd ?? undefined, summary: action.command };
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
