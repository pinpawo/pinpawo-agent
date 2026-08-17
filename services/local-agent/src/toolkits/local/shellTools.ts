import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { createAbortError, type ToolOperationMetadata } from '@pinpawo/pet-agent';
import { readRecord, readString } from '../operationMetadata';
import type { ShellRunHandle } from './processExecutor';
import { runShellCommand } from './processTree';
import type { ShellProcessBinding } from './processRegistry';
import { windowsProcessExecutor } from './windowsProcessExecutor';


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

export function createRunShellTool(binding: ShellProcessBinding | null) {
  // Run through the same executor the registry will terminate through.
  // Without a binding there is no registry, so pick by platform the same
  // way ShellRuntime does.
  const run = binding
    ? binding.registry.processExecutor.run
    : (process.platform === 'win32' ? windowsProcessExecutor.run : runShellCommand);

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

      const timeoutMs = resolveShellTimeoutMs(input.timeoutSeconds);
      const outcome = await run({
        command: shellAction.command,
        cwd: shellAction.cwd,
        timeoutMs,
        maxOutputChars: SHELL_MAX_CAPTURE_CHARS,
        ...(runtime.signal ? { signal: runtime.signal } : {}),
        // Only hand a slow command back if there is a registry to hold it.
        // Without a binding the old behaviour stands: terminate on timeout.
        yieldOnTimeout: binding !== null,
      });

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
          binding,
          handle: outcome.handle,
          command: shellAction.command,
          cwd: shellAction.cwd,
          timeoutMs,
        });
      }

      const out = truncateShellOutput(outcome.stdout.trimEnd());
      const err = truncateShellOutput(outcome.stderr.trimEnd());

      if (outcome.status === 'timeout') {
        const output = [err, out].filter(Boolean).join('\n');
        return [
          `Error: command timed out after ${(timeoutMs / 1000).toString()}s`,
          'and was terminated along with its child processes.',
          'If it needs longer and is not waiting for interactive input,'
          + ' retry with a larger timeoutSeconds.',
          output,
        ].filter(Boolean).join('\n').trimEnd();
      }

      if (outcome.status === 'exited' && outcome.pid !== undefined && binding) {
        // A command can exit cleanly having left work behind (`npm run dev &`).
        // Those children stay in the original process group, so registering it
        // keeps shutdown able to reach them.
        binding.registry.trackOrphanGroup(outcome.pid);
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
      description: '兜底工具：异步执行非交互 shell 命令并返回输出。只有没有更具体的专用工具覆盖时才使用；不要用它替代 view_file_chunk/read_file/jq_query/write_file/apply_patch/move_path/copy_path/mkdir_path/list_dir/glob_search/grep_search/http_fetch/download_file。默认在当前 workdir 执行，相对路径也默认相对于该目录；如有需要可显式传 cwd 覆盖。支持命令自身携带内容的 heredoc 和输出重定向，写入效果仍受 toolkit 审批约束。默认超时 60s，可通过 timeoutSeconds 调整（上限 600s）；输出过长时保留开头和结尾并标注截断。命令在超时后不会被中止，而是转入后台并返回一个进程 id，用 wait_process 继续跟进、terminate_process 终止；因此无需为构建、安装、测试等慢命令预先调大超时，也不要因为超时就重复执行同一命令。不要用于需要交互输入或全屏 TTY 的命令。命令会先进入 toolkit 审批，可批准、拒绝或给出新的处理方向。',
      schema: z.object({
        command: z.string().describe('要执行的 shell 命令'),
        cwd: z.string().optional().describe('命令执行目录；默认当前 workdir'),
        timeoutSeconds: z.number().int().positive().optional().describe('等待多少秒后转入后台；默认 60，上限 600'),
      }),
    },
  );
}

/**
 * Put a still-running command under registry ownership and tell the model how
 * to follow it.
 *
 * A timed-out command is slow, not failed. Reporting failure is what led a
 * model to rerun `pnpm install` while the first one was still writing to the
 * same node_modules, so the wording here deliberately frames the process as
 * ongoing work with a handle rather than an error.
 */
function adoptYieldedProcess(params: {
  binding: ShellProcessBinding | null;
  handle: ShellRunHandle;
  command: string;
  cwd: string;
  timeoutMs: number;
}) {
  const { binding, handle, command, cwd, timeoutMs } = params;
  const seconds = (timeoutMs / 1000).toString();

  if (!binding) {
    // yieldOnTimeout is only requested when a binding exists, so this is
    // unreachable; terminate rather than leak a handle nothing holds.
    handle.terminate();
    return `Error: command timed out after ${seconds}s and was terminated.`;
  }

  let record;
  try {
    record = binding.registry.register({
      handle,
      owner: binding.owner,
      command,
      cwd,
      // The output so far is included in this result, so wait_process should
      // start from what comes next.
      outputAlreadyDelivered: true,
    });
  } catch (err) {
    handle.terminate();
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  const out = truncateShellOutput(handle.stdout.trimEnd());
  const err = truncateShellOutput(handle.stderr.trimEnd());
  const output = [
    out || '(no output yet)',
    err ? `--- stderr ---\n${err}` : '',
  ].filter(Boolean).join('\n');

  return [
    `Command is still running after ${seconds}s and moved to the background.`,
    `Process id: ${record.processId}`,
    `Use wait_process to follow it, or terminate_process to stop it.`,
    'Do not rerun the same command; it is still in progress.',
    output,
  ].join('\n');
}

/** Static schema inventory; a runtime binding replaces only the implementation. */
export const runShellTool = createRunShellTool(null);

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
