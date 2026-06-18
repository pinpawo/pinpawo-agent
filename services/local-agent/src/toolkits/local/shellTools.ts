import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { ToolkitOperationMetadata } from '@pinpawo/pet-agent';
import { getCurrentLocalAgentInterface } from '../../chatInterface';
import { readRecord, readString } from '../operationMetadata';
import { getLocalToolsWorkdir, resolveUserPath } from './pathUtils';

export function getBlockedShellReason(command: string) {
  const normalized = command.trim();

  const blockedPatterns: Array<[RegExp, string]> = [
    [/(^|[\s;&|])mv(\s|$)/, '禁止直接使用 mv；请改用 move_path。'],
    [/\bgit\s+reset\s+--hard\b/, '禁止使用 git reset --hard 这类破坏性命令。'],
    [/(^|[\s;&|])sudo(\s|$)/, '禁止通过 sudo 提权执行命令。'],
    [/(^|[\s;&|])(mkfs|fdisk|shutdown|reboot|dd)(\s|$)/, '禁止执行高风险系统命令。'],
    [/\bcat\s*>\s*/, 'run_shell 不支持依赖 stdin 的 cat > 写文件；请改用 write_file。'],
    [/<<[-\w'"]*/, 'run_shell 不支持 heredoc；请改用 write_file。'],
  ];

  for (const [pattern, reason] of blockedPatterns) {
    if (pattern.test(normalized)) {
      return reason;
    }
  }

  if (hasBlockedOutputRedirection(normalized)) {
    return 'run_shell 不支持输出重定向写文件；请改用 write_file。';
  }

  return null;
}

export function hasBlockedOutputRedirection(command: string) {
  const withoutFdDuplication = command.replace(/(^|[\s;&|])\d*>\s*&\d+\b/g, '$1');
  const withoutDevNull = withoutFdDuplication.replace(/[&\d]*>>?\s*\/dev\/null\b/g, '');
  return /(^|[^=>])\d*>>?/.test(withoutDevNull);
}

function processOutputToString(output: unknown) {
  if (typeof output === 'string') {
    return output.trimEnd();
  }
  if (Buffer.isBuffer(output)) {
    return output.toString('utf-8').trimEnd();
  }
  return '';
}

export function getShellConfirmationRisk(command: string) {
  const normalized = command.trim();

  const confirmPatterns: Array<[RegExp, string]> = [
    [/(^|[\s;&|])rm(\s|$)/, '删除文件或目录'],
    [/\bgit\s+(push|tag|rebase|merge|cherry-pick|commit)\b/, 'git 写操作或远端变更'],
    [/\b(npm|pnpm|yarn)\s+publish\b/, '包发布'],
    [/\b(kubectl|helm)\s+(apply|delete|rollout|upgrade|uninstall)\b/, '集群部署变更'],
    [/\bdocker\s+(push|buildx\s+build|compose\s+(up|down)|run)\b/, '容器构建或运行变更'],
    [/\b(chmod|chown)\b/, '权限或属主变更'],
    [/\bfind\b[\s\S]*\s-delete\b/, '批量删除'],
    [/\bcurl\b[\s\S]*\|\s*(sh|bash|zsh)\b/, '远程脚本直接执行'],
  ];

  for (const [pattern, risk] of confirmPatterns) {
    if (pattern.test(normalized)) {
      return risk;
    }
  }

  return null;
}

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

const execFileAsync = promisify(execFile);

const DEFAULT_SHELL_TIMEOUT_SECONDS = 60;
const MAX_SHELL_TIMEOUT_SECONDS = 600;
const SHELL_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const SHELL_OUTPUT_LIMIT_CHARS = 20_000;

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

export const runShellTool = tool(
  async (input: { command: string; cwd?: string; timeoutSeconds?: number }) => {
    let shellAction: { command: string; cwd: string };

    try {
      shellAction = normalizeShellActionInput(input);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }

    const blockedReason = getBlockedShellReason(shellAction.command);
    if (blockedReason) {
      return `Error: ${blockedReason}`;
    }

    const confirmationRisk = getShellConfirmationRisk(shellAction.command);
    const { capabilities } = getCurrentLocalAgentInterface();
    if (confirmationRisk && !capabilities.humanReview) {
      return `Error: shell command requires human review before execution: ${confirmationRisk}`;
    }

    const timeoutMs = resolveShellTimeoutMs(input.timeoutSeconds);

    try {
      const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', shellAction.command], {
        encoding: 'utf-8',
        timeout: timeoutMs,
        maxBuffer: SHELL_MAX_BUFFER_BYTES,
        cwd: shellAction.cwd,
      });
      const out = truncateShellOutput(processOutputToString(stdout));
      const err = truncateShellOutput(processOutputToString(stderr));
      return [out || '(no output)', err ? `--- stderr ---\n${err}` : '']
        .filter(Boolean)
        .join('\n');
    } catch (err) {
      if (err instanceof Error && ('stdout' in err || 'stderr' in err)) {
        const stdout = truncateShellOutput(processOutputToString((err as { stdout?: unknown }).stdout));
        const stderr = truncateShellOutput(processOutputToString((err as { stderr?: unknown }).stderr));
        const output = [stderr, stdout].filter(Boolean).join('\n');
        const killed = Boolean((err as { killed?: boolean }).killed);
        const signal = (err as { signal?: string | null }).signal;
        if (killed || signal === 'SIGTERM') {
          return `Error: command timed out after ${(timeoutMs / 1000).toString()}s\n${output}`.trimEnd();
        }
        const status = (err as NodeJS.ErrnoException & { code?: unknown }).code;
        const exitCode = typeof status === 'number' ? status : '?';
        return `Error (exit ${exitCode.toString()}):\n${output || err.message}`;
      }
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'run_shell',
    description: '兜底工具：异步执行非交互 shell 命令并返回输出。只有没有更具体的专用工具覆盖时才使用；不要用它替代 view_file_chunk/read_file/write_file/apply_patch/move_path/copy_path/mkdir_path/list_dir/glob_search/grep_search/http_fetch/download_file。默认在当前 workdir 执行，相对路径也默认相对于该目录；如有需要可显式传 cwd 覆盖。默认超时 60s，可通过 timeoutSeconds 调整（上限 600s）；输出过长时保留开头和结尾并标注截断。不要用于需要输入、全屏 TTY、持续运行，或依赖 stdin 的命令（例如 cat > file）。高风险命令会先进入 toolkit 审批，可批准、拒绝或给出新的处理方向。',
    schema: z.object({
      command: z.string().describe('要执行的 shell 命令'),
      cwd: z.string().optional().describe('命令执行目录；默认当前 workdir'),
      timeoutSeconds: z.number().int().positive().optional().describe('超时秒数；默认 60，上限 600。运行测试或构建等较慢命令时记得调大'),
    }),
  },
);

export const shellOperationMetadata: Record<string, ToolkitOperationMetadata> = {
  run_shell: {
    title: '执行命令',
    summarizeInput: (input) => {
      const record = readRecord(input);
      const command = readString(record, 'command');
      return {
        target: readString(record, 'cwd'),
        summary: command,
        details: {
          risk: command ? getShellConfirmationRisk(command) : undefined,
        },
      };
    },
  },
};
