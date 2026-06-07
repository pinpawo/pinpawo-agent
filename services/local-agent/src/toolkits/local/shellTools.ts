import { execSync } from 'node:child_process';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  buildHumanReviewRequest,
  type ToolkitOperationMetadata,
  type HumanReviewActionRequest,
  type ToolkitToolReviewPolicy,
} from '@pinpawo/pet-agent';
import { getCurrentLocalAgentInterface } from '../../chatInterface';
import { isShellCommandAuthorized } from '../../sessionAuthorizations';
import { config } from '../../config';
import { readRecord, readString } from '../operationMetadata';
import { resolveUserPath } from './pathUtils';

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
  return /(^|[^=>])\d*>>?/.test(withoutFdDuplication);
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

function buildShellHumanReviewRequest(command: string, cwd: string, risk: string) {
  return buildHumanReviewRequest({
    actionRequests: [{
      name: 'run_shell',
      args: { command, cwd },
      description: `即将执行高风险 shell 命令（${risk}）。`,
    }],
    reviewConfigs: [{
      actionName: 'run_shell',
      allowedDecisions: ['approve', 'edit', 'reject', 'respond'],
      description: risk,
    }],
    prompt: `即将执行高风险 shell 命令（${risk}）。\n目录：${cwd}\n命令：${command}\n请确认是否执行，或修改命令/说明新的处理方向。`,
  });
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
    : config.workdir;
  return { command, cwd };
}

function readEditedShellAction(
  editedAction: HumanReviewActionRequest,
  fallback: { command: string; cwd: string },
) {
  if (
    editedAction.name !== 'run_shell'
    && editedAction.name !== 'shell'
  ) {
    return fallback;
  }
  const command = typeof editedAction.args.command === 'string' && editedAction.args.command.trim()
    ? editedAction.args.command.trim()
    : fallback.command;
  const cwd = typeof editedAction.args.cwd === 'string' && editedAction.args.cwd.trim()
    ? resolveUserPath(editedAction.args.cwd.trim())
    : fallback.cwd;
  return { command, cwd };
}

export const runShellTool = tool(
  async (input: { command: string; cwd?: string }) => {
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
    const { threadId, capabilities } = getCurrentLocalAgentInterface();
    const isAuthorized = threadId && capabilities.sessionAuthorization
      ? isShellCommandAuthorized(threadId, shellAction.command)
      : false;
    if (confirmationRisk && !isAuthorized && !capabilities.humanReview) {
      return `Error: shell command requires human review before execution: ${confirmationRisk}`;
    }

    try {
      const output = execSync(shellAction.command, {
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 64,
        cwd: shellAction.cwd,
      });
      return output.slice(0, 4000) || '(no output)';
    } catch (err) {
      if (err instanceof Error && ('stdout' in err || 'stderr' in err)) {
        const stdout = processOutputToString((err as { stdout?: unknown }).stdout);
        const stderr = processOutputToString((err as { stderr?: unknown }).stderr);
        const output = [stderr, stdout].filter(Boolean).join('\n');
        const status = (err as NodeJS.ErrnoException & { status?: number }).status ?? '?';
        return `Error (exit ${status}):\n${output || err.message}`;
      }
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'run_shell',
    description: '兜底工具：执行非交互 shell 命令并返回输出。只有没有更具体的专用工具覆盖时才使用；不要用它替代 view_file_chunk/read_file/write_file/update_file/move_path/copy_path/mkdir_path/list_dir/glob_search/grep_search/http_fetch/download_file。默认在当前 workdir 执行，相对路径也默认相对于该目录；如有需要可显式传 cwd 覆盖。超时 10s，输出截断至 4000 字符；不要用于需要输入、全屏 TTY、持续运行，或依赖 stdin 的命令（例如 cat > file）。高风险命令会先进入 toolkit 审批，可批准、编辑、拒绝或给出新的处理方向。',
    schema: z.object({
      command: z.string().describe('要执行的 shell 命令'),
      cwd: z.string().optional().describe('命令执行目录；默认当前 workdir'),
    }),
  },
);

export const shellReviewPolicy: ToolkitToolReviewPolicy = {
  request: ({ input }) => {
    let shellAction: { command: string; cwd: string };
    try {
      shellAction = normalizeShellActionInput(input);
    } catch {
      return null;
    }

    if (getBlockedShellReason(shellAction.command)) {
      return null;
    }

    const confirmationRisk = getShellConfirmationRisk(shellAction.command);
    if (!confirmationRisk) {
      return null;
    }

    const { threadId, capabilities } = getCurrentLocalAgentInterface();
    const isAuthorized = threadId && capabilities.sessionAuthorization
      ? isShellCommandAuthorized(threadId, shellAction.command)
      : false;
    if (isAuthorized) {
      return null;
    }

    if (!capabilities.humanReview) {
      return null;
    }

    return buildShellHumanReviewRequest(
      shellAction.command,
      shellAction.cwd,
      confirmationRisk,
    );
  },
  applyEdit: ({ input, editedAction }) => readEditedShellAction(
    editedAction,
    normalizeShellActionInput(input),
  ),
};

export const shellOperationMetadata: Record<string, ToolkitOperationMetadata> = {
  run_shell: {
    title: '执行命令',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'cwd'),
        summary: readString(record, 'command'),
      };
    },
  },
};
