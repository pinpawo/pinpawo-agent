import { tool, type StructuredTool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import type { ToolOperationMetadata } from '@pinpawo/pet-agent';
import { readRecord, readString } from '../operationMetadata';
import { requireAgentSession } from './executionContext';
import type { ShellProcessSnapshot, ShellRS } from './shellRS';
import { truncateShellOutput } from './shellTools';

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
      { processId, waitSeconds }: { processId: string; waitSeconds?: number },
      runtime: ToolRuntime,
    ) => {
      try {
        const sessionId = requireAgentSession(runtime);
        const seconds = Math.min(
          Math.max(1, Math.floor(waitSeconds ?? DEFAULT_WAIT_SECONDS)),
          MAX_WAIT_SECONDS,
        );
        const result = await shell.wait(sessionId, processId, seconds * 1000);
        const header = `Process ${processId} is ${describeStatus(result.process)}.`;
        const hint = result.process.status === 'running'
          ? `\nCall ${WAIT_PROCESS_TOOL_NAME} again to keep waiting,`
            + ` or ${TERMINATE_PROCESS_TOOL_NAME} to stop it.`
          : '';
        return `${header}${hint}\n${renderOutput(result.stdout, result.stderr)}`;
      } catch (err) {
        return formatProcessError(err);
      }
    },
    {
      name: WAIT_PROCESS_TOOL_NAME,
      description: '等待一个后台进程并读取自上次查看以来的新增输出。'
        + 'start_process 启动任务后，用它继续跟进；进程未结束时会在等待若干秒后返回当前进度，可重复调用。'
        + '每次只返回新增输出，不会重复历史内容。',
      schema: z.object({
        processId: z.string().min(1).describe('start_process 返回的进程 id'),
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
