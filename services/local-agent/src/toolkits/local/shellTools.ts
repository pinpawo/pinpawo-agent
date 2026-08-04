import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { createAbortError, type ToolOperationMetadata } from '@pinpawo/pet-agent';
import { readRecord, readString } from '../operationMetadata';
import { getLocalToolsWorkdir, resolveUserPath } from './pathUtils';
import { runShellCommand } from './processTree';


export function normalizeShellActionInput(input: unknown) {
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
  const cwd = typeof record.cwd === 'string' && record.cwd.trim()
    ? resolveUserPath(record.cwd.trim())
    : getLocalToolsWorkdir();
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

export const runShellTool = tool(
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

    const timeoutMs = resolveShellTimeoutMs(input.timeoutSeconds);
    const outcome = await runShellCommand({
      command: shellAction.command,
      cwd: shellAction.cwd,
      timeoutMs,
      maxOutputChars: SHELL_MAX_CAPTURE_CHARS,
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    });

    if (outcome.status === 'spawn_failed') {
      return `Error: ${outcome.error.message}`;
    }

    // Cancellation is not a result. Let it propagate so the graph unwinds
    // instead of feeding the model a string that reads like a failure.
    if (outcome.status === 'aborted') {
      throw createAbortError();
    }

    const out = truncateShellOutput(outcome.stdout.trimEnd());
    const err = truncateShellOutput(outcome.stderr.trimEnd());

    if (outcome.status === 'timeout') {
      const output = [err, out].filter(Boolean).join('\n');
      return [
        `Error: command timed out after ${(timeoutMs / 1000).toString()}s`,
        'and was terminated along with its child processes.',
        output,
      ].filter(Boolean).join('\n').trimEnd();
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
    name: 'run_shell',
    description: '兜底工具：异步执行非交互 shell 命令并返回输出。只有没有更具体的专用工具覆盖时才使用；不要用它替代 view_file_chunk/read_file/jq_query/write_file/apply_patch/move_path/copy_path/mkdir_path/list_dir/glob_search/grep_search/http_fetch/download_file。默认在当前 workdir 执行，相对路径也默认相对于该目录；如有需要可显式传 cwd 覆盖。支持命令自身携带内容的 heredoc 和输出重定向，写入效果仍受 toolkit 审批约束。默认超时 60s，可通过 timeoutSeconds 调整（上限 600s）；输出过长时保留开头和结尾并标注截断。不要用于需要交互输入、全屏 TTY 或持续运行的命令。命令会先进入 toolkit 审批，可批准、拒绝或给出新的处理方向。',
    schema: z.object({
      command: z.string().describe('要执行的 shell 命令'),
      cwd: z.string().optional().describe('命令执行目录；默认当前 workdir'),
      timeoutSeconds: z.number().int().positive().optional().describe('超时秒数；默认 60，上限 600。运行测试或构建等较慢命令时记得调大'),
    }),
  },
);

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
      const shellAction = normalizeShellActionInput(input);
      return {
        target: shellAction.cwd,
        summary: shellAction.command,
      };
    },
  },
};
