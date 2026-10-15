import { tool, type StructuredTool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import type { ToolOperationMetadata } from '@pinpawo/pet-agent';
import { readRecord, readString } from '../operationMetadata';
import { requireAgentSession } from '../executionContext';
import type { ShellProcessSnapshot, ShellRS } from '../shellRS/shellRS';
import { truncateShellOutput } from './shellTools';
import { SHELL_CAPTURE_LIMIT_CHARS, SHELL_OUTPUT_PAGE_LIMIT_CHARS } from '../shellRS/shellRS';

/**
 * Tools for managed tasks explicitly launched by `start_process`.
 *
 * They address the ShellRS logical session of the calling Agent session, so
 * any run or delegation of that session can follow, stop or list what an
 * earlier one started; another session's processes are out of reach.
 */

const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 600;

export const WAIT_PROCESS_TOOL_NAME = 'wait_process';
export const TERMINATE_PROCESS_TOOL_NAME = 'terminate_process';
export const LIST_PROCESSES_TOOL_NAME = 'list_processes';

function describeStatus(record: ShellProcessSnapshot) {
  if (record.status === 'running') return 'still running';
  if (record.status === 'terminated') return 'terminated';
  return record.exitCode === null
    ? 'finished'
    : `exited with code ${record.exitCode.toString()}`;
}

function renderOutput(stdout: string, stderr: string) {
  const out = truncateShellOutput(stdout.trimEnd());
  const err = truncateShellOutput(stderr.trimEnd());
  const sections = [
    out || '(no new output)',
    err ? `--- stderr ---\n${err}` : '',
  ];
  return sections.filter(Boolean).join('\n');
}

function formatProcessError(err: unknown) {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

export function createProcessTools(shell: ShellRS): StructuredTool[] {
  const waitProcessTool = tool(
    async (
      { processId, waitSeconds, outputOffset, outputLimit }: {
        processId: string; waitSeconds?: number; outputOffset?: number; outputLimit?: number;
      },
      runtime: ToolRuntime,
    ) => {
      try {
        const sessionId = requireAgentSession(runtime);
        if (outputLimit !== undefined && outputOffset === undefined) {
          throw new Error('outputLimit requires outputOffset.');
        }
        const seconds = Math.min(
          Math.max(1, Math.floor(waitSeconds ?? DEFAULT_WAIT_SECONDS)),
          MAX_WAIT_SECONDS,
        );
        const result = outputOffset === undefined
          ? await shell.wait(sessionId, processId, seconds * 1000)
          : await shell.read(sessionId, processId, { offset: outputOffset, limit: outputLimit ?? SHELL_OUTPUT_PAGE_LIMIT_CHARS });
        const header = `Process ${processId} is ${describeStatus(result.process)}.`;
        const hint = result.process.status === 'running'
          ? `\nCall ${WAIT_PROCESS_TOOL_NAME} again to keep waiting,`
            + ` or ${TERMINATE_PROCESS_TOOL_NAME} to stop it.`
          : '';
        const capture = result.capture;
        const replay = capture
          ? `\nCaptured output page: offset=${capture.offset}, limit=${capture.limit}, stdoutChars=${capture.stdoutChars}, stderrChars=${capture.stderrChars}.`
          : `\nTo reread retained output, call wait_process with outputOffset (absolute character offset) and outputLimit (max 20000).`;
        const omitted = (result.omittedStdoutChars || result.omittedStderrChars)
          ? `\nIncremental buffer overflow: omitted stdout=${result.omittedStdoutChars ?? 0}, stderr=${result.omittedStderrChars ?? 0} characters.` : '';
        return `${header}${hint}${replay}${omitted}\n${renderOutput(result.stdout, result.stderr)}`;
      } catch (err) {
        return formatProcessError(err);
      }
    },
    {
      name: WAIT_PROCESS_TOOL_NAME,
      description: '等待一个后台进程并读取自上次查看以来的新增输出。'
        + 'start_process 启动任务后，用它继续跟进；进程未结束时会在等待若干秒后返回当前进度，可重复调用。'
        + '默认只返回新增输出。传 outputOffset 可立即分页回读保留的历史输出，不等待、不消耗新增输出；offset 对 stdout/stderr 分别按字符计数。'
        + `每流最多保留前 ${SHELL_CAPTURE_LIMIT_CHARS} 字符，退出后保留最多5分钟，RS关闭时清除；达到上限后的内容不能回读。`,
      schema: z.object({
        processId: z.string().min(1).describe('start_process 返回的进程 id'),
        outputOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
          .describe('绝对字符偏移；提供时立即回读保留输出，不等待或消耗新增输出'),
        outputLimit: z.number().int().min(1).max(SHELL_OUTPUT_PAGE_LIMIT_CHARS).optional()
          .describe('回读每流最多字符数，默认20000；与 outputOffset 一起使用'),
        waitSeconds: z.number().int().positive().max(MAX_WAIT_SECONDS).optional()
          .describe(`最多等待多少秒后返回当前进度，默认 ${DEFAULT_WAIT_SECONDS.toString()}`),
      }),
    },
  );

  const terminateProcessTool = tool(
    async ({ processId }: { processId: string }, runtime: ToolRuntime) => {
      try {
        const record = await shell.terminate(requireAgentSession(runtime), processId);
        return `Process ${processId} is ${describeStatus(record)}.`;
      } catch (err) {
        return formatProcessError(err);
      }
    },
    {
      name: TERMINATE_PROCESS_TOOL_NAME,
      description: '终止一个后台进程及其子进程。确认不再需要该命令继续运行时使用。',
      schema: z.object({
        processId: z.string().min(1).describe('start_process 返回的进程 id'),

      }),
    },
  );

  const listProcessesTool = tool(
    async (_input: Record<string, never>, runtime: ToolRuntime) => {
      try {
        const records = await shell.list(requireAgentSession(runtime));
        if (records.length === 0) return 'No background processes.';
        return records
          .map((record) => `${record.processId}  ${describeStatus(record)}  ${record.command}`)
          .join('\n');
      } catch (err) {
        return formatProcessError(err);
      }
    },
    {
      name: LIST_PROCESSES_TOOL_NAME,
      description: '列出当前会话启动的后台进程及其状态。',
      schema: z.object({}),
    },
  );

  return [waitProcessTool, terminateProcessTool, listProcessesTool];
}

export const processOperationMetadata: Record<string, ToolOperationMetadata> = {
  [WAIT_PROCESS_TOOL_NAME]: {
    title: '等待进程',
    summarizeInput: (input) => ({
      target: readString(readRecord(input), 'processId'),
    }),
  },
  [TERMINATE_PROCESS_TOOL_NAME]: {
    title: '终止进程',
    summarizeInput: (input) => ({
      target: readString(readRecord(input), 'processId'),
    }),
  },
  [LIST_PROCESSES_TOOL_NAME]: {
    title: '列出后台进程',
  },
};
