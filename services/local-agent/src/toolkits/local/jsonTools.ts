import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { ToolOperationMetadata } from '@pinpawo/pet-agent';
import { readRecord, readString } from '../operationMetadata';
import { resolveUserPath } from './pathUtils';

const JQ_TIMEOUT_MS = 30_000;
const JQ_OUTPUT_LIMIT_CHARS = 50_000;

type JqExecResult = {
  stdout: string | Buffer;
  stderr: string | Buffer;
  stdoutTotalChars?: number;
  stderrTotalChars?: number;
};

type JqExecOptions = {
  cwd: string;
  encoding: 'utf-8';
  env: Record<string, string>;
  timeout: number;
};

type JqExec = (
  file: string,
  args: string[],
  options: JqExecOptions,
) => Promise<JqExecResult>;

function createBoundedTextCollector(limit: number) {
  const decoder = new StringDecoder('utf-8');
  let text = '';
  let totalChars = 0;

  const append = (value: string) => {
    totalChars += value.length;
    if (text.length < limit) {
      text += value.slice(0, limit - text.length);
    }
  };

  return {
    push(chunk: Buffer) {
      append(decoder.write(chunk));
    },
    finish() {
      append(decoder.end());
      return { text, totalChars };
    },
  };
}

export const runJqProcess: JqExec = (file, args, options) => new Promise((resolve, reject) => {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout = createBoundedTextCollector(JQ_OUTPUT_LIMIT_CHARS);
  const stderr = createBoundedTextCollector(JQ_OUTPUT_LIMIT_CHARS);
  let timedOut = false;

  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, options.timeout);

  child.once('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    const stdoutResult = stdout.finish();
    const stderrResult = stderr.finish();
    const result: JqExecResult = {
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      stdoutTotalChars: stdoutResult.totalChars,
      stderrTotalChars: stderrResult.totalChars,
    };
    if (code === 0 && !timedOut) {
      resolve(result);
      return;
    }
    reject(Object.assign(new Error(`jq exited with code ${code?.toString() ?? '?'}${signal ? ` (${signal})` : ''}`), {
      code,
      killed: timedOut,
      signal,
      ...result,
    }));
  });
});

function outputText(value: string | Buffer) {
  return Buffer.isBuffer(value) ? value.toString('utf-8') : value;
}

function truncateJqOutput(output: string, totalChars = output.length) {
  if (totalChars <= JQ_OUTPUT_LIMIT_CHARS) return output;
  const kept = output.slice(0, JQ_OUTPUT_LIMIT_CHARS);
  return `${kept}\n[truncated ${(totalChars - kept.length).toString()} chars]`;
}

export type JqQueryInput = {
  path: string;
  filter: string;
  rawOutput?: boolean;
  compactOutput?: boolean;
};

export async function runJqQuery(input: JqQueryInput, run: JqExec = runJqProcess) {
  const filePath = resolveUserPath(input.path);
  const filter = input.filter.trim();
  if (!filter) return 'Error: jq_query requires a filter';

  try {
    const fileStat = statSync(filePath);
    if (!fileStat.isFile()) {
      return `Error: jq_query path is not a file: ${filePath}`;
    }
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : error}`;
  }

  const args = [
    '--monochrome-output',
    ...(input.rawOutput ? ['--raw-output'] : []),
    ...(input.compactOutput === false ? [] : ['--compact-output']),
    '--',
    filter,
    filePath,
  ];

  try {
    const {
      stdout,
      stderr,
      stdoutTotalChars,
      stderrTotalChars,
    } = await run('jq', args, {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      },
      timeout: JQ_TIMEOUT_MS,
    });
    const out = truncateJqOutput(outputText(stdout).trimEnd(), stdoutTotalChars);
    const err = truncateJqOutput(outputText(stderr).trimEnd(), stderrTotalChars);
    return [out || '(no output)', err ? `--- stderr ---\n${err}` : '']
      .filter(Boolean)
      .join('\n');
  } catch (error) {
    const typed = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string | null;
      stderr?: string | Buffer;
      stdout?: string | Buffer;
      stderrTotalChars?: number;
      stdoutTotalChars?: number;
    };
    if (typed.code === 'ENOENT') {
      return 'Error: jq is not installed or is not available on PATH.';
    }
    const stderr = typed.stderr ? outputText(typed.stderr).trimEnd() : '';
    const stdout = typed.stdout ? outputText(typed.stdout).trimEnd() : '';
    const combined = [stderr, stdout].filter(Boolean).join('\n');
    const combinedTotalChars = (typed.stderrTotalChars ?? stderr.length)
      + (typed.stdoutTotalChars ?? stdout.length)
      + (stderr && stdout ? 1 : 0);
    const detail = truncateJqOutput(combined, combinedTotalChars);
    if (typed.killed || typed.signal === 'SIGTERM') {
      return `Error: jq_query timed out after 30s${detail ? `\n${detail}` : ''}`;
    }
    return `Error: ${detail || (error instanceof Error ? error.message : error)}`;
  }
}

export const jqQueryTool = tool(
  (input: JqQueryInput) => runJqQuery(input),
  {
    name: 'jq_query',
    description: '使用本机 jq 对一个 JSON 文件做只读查询。适合先查看 keys、数组长度、筛选字段、分组计数和生成紧凑摘要；可读取当前 workdir 之外由用户提供的显式文件路径。直接传 jq filter，不要再用 run_shell 或临时 Python 脚本包装 jq。输出默认使用 jq compact JSON，并限制为 50000 字符。',
    schema: z.object({
      path: z.string().describe('要查询的 JSON 文件路径'),
      filter: z.string().describe('jq filter，例如 .runs | length 或 .runs[] | .langsmith.name'),
      rawOutput: z.boolean().optional().describe('对应 jq --raw-output；默认 false'),
      compactOutput: z.boolean().optional().describe('对应 jq --compact-output；默认 true'),
    }),
  },
);

export const jsonOperationMetadata: Record<string, ToolOperationMetadata> = {
  jq_query: {
    title: '查 JSON',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'path'),
        summary: readString(record, 'filter'),
      };
    },
  },
};
