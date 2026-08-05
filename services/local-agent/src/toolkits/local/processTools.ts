import { tool, type StructuredTool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import type { ToolOperationMetadata } from '@pinpawo/pet-agent';
import { readRecord, readString } from '../operationMetadata';
import {
  ProcessRegistryError,
  type ProcessSnapshot,
  type ShellProcessBinding,
} from './processRegistry';
import { truncateShellOutput } from './shellTools';

/**
 * Tools for the processes `run_shell` hands back when a command outlives its
 * timeout.
 *
 * These only exist once the bash toolkit resolves a runtime binding: without
 * one there is no registry to address, and no process ids will have been
 * issued either, so the tools report that plainly rather than pretending.
 */

const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 600;

export const WAIT_PROCESS_TOOL_NAME = 'wait_process';
export const TERMINATE_PROCESS_TOOL_NAME = 'terminate_process';
export const LIST_PROCESSES_TOOL_NAME = 'list_processes';

function describeStatus(record: ProcessSnapshot) {
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

function formatRegistryError(err: unknown) {
  if (err instanceof ProcessRegistryError) {
    return `Error: ${err.message}`;
  }
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

export function createProcessTools(
  binding: ShellProcessBinding | null,
): StructuredTool[] {
  const requireBinding = () => {
    if (!binding) {
      throw new ProcessRegistryError(
        'unknown_process',
        'No background processes are available in this execution.',
      );
    }
    return binding;
  };

  const waitProcessTool = tool(
    async (
      { processId, waitSeconds }: { processId: string; waitSeconds?: number },
      _runtime: ToolRuntime,
    ) => {
      try {
        const { registry, owner } = requireBinding();
        const seconds = Math.min(
          Math.max(1, Math.floor(waitSeconds ?? DEFAULT_WAIT_SECONDS)),
          MAX_WAIT_SECONDS,
        );
        const result = await registry.wait(processId, owner, seconds * 1000);
        const header = `Process ${processId} is ${describeStatus(result.process)}.`;
        const hint = result.process.status === 'running'
          ? `\nCall ${WAIT_PROCESS_TOOL_NAME} again to keep waiting,`
            + ` or ${TERMINATE_PROCESS_TOOL_NAME} to stop it.`
          : '';
        return `${header}${hint}\n${renderOutput(result.stdout, result.stderr)}`;
      } catch (err) {
        return formatRegistryError(err);
      }
    },
    {
      name: WAIT_PROCESS_TOOL_NAME,
      description: '等待一个后台进程并读取自上次查看以来的新增输出。'
        + '命令超时转入后台后，用它继续跟进；进程未结束时会在等待若干秒后返回当前进度，可重复调用。'
        + '每次只返回新增输出，不会重复历史内容。',
      schema: z.object({
        processId: z.string().min(1).describe('run_shell 返回的进程 id'),
        waitSeconds: z.number().int().positive().max(MAX_WAIT_SECONDS).optional()
          .describe(`最多等待多少秒后返回当前进度，默认 ${DEFAULT_WAIT_SECONDS.toString()}`),
      }),
    },
  );

  const terminateProcessTool = tool(
    async ({ processId }: { processId: string }, _runtime: ToolRuntime) => {
      try {
        const { registry, owner } = requireBinding();
        const record = await registry.terminate(processId, owner);
        return `Process ${processId} is ${describeStatus(record)}.`;
      } catch (err) {
        return formatRegistryError(err);
      }
    },
    {
      name: TERMINATE_PROCESS_TOOL_NAME,
      description: '终止一个后台进程及其子进程。确认不再需要该命令继续运行时使用。',
      schema: z.object({
        processId: z.string().min(1).describe('run_shell 返回的进程 id'),
      }),
    },
  );

  const listProcessesTool = tool(
    async (_input: Record<string, never>, _runtime: ToolRuntime) => {
      if (!binding) return 'No background processes.';
      const records = binding.registry.list(binding.owner);
      if (records.length === 0) return 'No background processes.';
      return records
        .map((record) => `${record.processId}  ${describeStatus(record)}  ${record.command}`)
        .join('\n');
    },
    {
      name: LIST_PROCESSES_TOOL_NAME,
      description: '列出本次执行启动的后台进程及其状态。',
      schema: z.object({}),
    },
  );

  return [waitProcessTool, terminateProcessTool, listProcessesTool];
}

/** Static schema inventory; runtime binding replaces only the implementations. */
export const processTools = createProcessTools(null);

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
