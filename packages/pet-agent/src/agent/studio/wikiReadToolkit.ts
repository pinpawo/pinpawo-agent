import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ToolkitOperationMetadata } from '../../types/toolkit';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 64 * 1024;

function readString(input: unknown, key: string) {
  if (!input || typeof input !== 'object' || !(key in input)) {
    return null;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

function readNumber(input: unknown, key: string) {
  if (!input || typeof input !== 'object' || !(key in input)) {
    return null;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function truncate(text: string, limit = MAX_OUTPUT_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  // 简单按字符截断,标注 [truncated]
  let result = text.slice(0, limit);
  while (Buffer.byteLength(result, 'utf8') > limit) {
    result = result.slice(0, result.length - 16);
  }
  return `${result}\n[output truncated, exceeded ${limit} bytes]`;
}

function ensureInsideRoot(root: string, target: string): string {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(absoluteRoot, target);
  const rel = path.relative(absoluteRoot, absoluteTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path "${target}" escapes wiki root`);
  }
  return absoluteTarget;
}

export const wikiReadToolOperations = {
  wiki_read_ls: {
    kind: 'wiki.dir.list',
    title: '列出知识库',
    summarizeInput: (input: unknown) => {
      const target = readString(input, 'path') ?? '.';
      return {
        target,
        summary: target === '.' ? '列出根目录' : `列出 ${target}`,
      };
    },
  },
  wiki_read_cat: {
    kind: 'wiki.file.read',
    title: '读取知识库文件',
    summarizeInput: (input: unknown) => ({
      target: readString(input, 'path') ?? undefined,
      summary: '读取完整文件',
    }),
  },
  wiki_read_grep: {
    kind: 'wiki.search.grep',
    title: '搜索知识库内容',
    summarizeInput: (input: unknown) => {
      const pattern = readString(input, 'pattern');
      const target = readString(input, 'path') ?? '.';
      return {
        target,
        summary: pattern ?? undefined,
        details: {
          pattern,
          path: target,
        },
      };
    },
  },
  wiki_read_find: {
    kind: 'wiki.search.find',
    title: '查找知识库文件',
    summarizeInput: (input: unknown) => {
      const name = readString(input, 'name');
      const ext = readString(input, 'ext');
      return {
        target: name ?? (ext ? `*.${ext.replace(/^\./, '')}` : undefined),
        summary: name ?? (ext ? `扩展名 ${ext.replace(/^\./, '')}` : '查找文件'),
        details: {
          name,
          ext,
        },
      };
    },
  },
  wiki_read_head: {
    kind: 'wiki.file.head',
    title: '读取知识库文件开头',
    summarizeInput: (input: unknown) => {
      const target = readString(input, 'path');
      const count = readNumber(input, 'n') ?? 20;
      return {
        target: target ?? undefined,
        summary: `读取前 ${count} 行`,
        details: { lines: count },
      };
    },
  },
  wiki_read_tail: {
    kind: 'wiki.file.tail',
    title: '读取知识库文件结尾',
    summarizeInput: (input: unknown) => {
      const target = readString(input, 'path');
      const count = readNumber(input, 'n') ?? 20;
      return {
        target: target ?? undefined,
        summary: `读取最后 ${count} 行`,
        details: { lines: count },
      };
    },
  },
} satisfies Record<string, ToolkitOperationMetadata>;

async function readDirRecursive(absolutePath: string, root: string, depth: number, maxDepth = 8): Promise<string[]> {
  const lines: string[] = [];
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    const childAbs = path.join(absolutePath, entry.name);
    const childRel = path.relative(root, childAbs);
    if (entry.isDirectory()) {
      lines.push(`${childRel}/`);
      if (depth < maxDepth) {
        lines.push(...(await readDirRecursive(childAbs, root, depth + 1, maxDepth)));
      }
    } else if (entry.isFile()) {
      lines.push(childRel);
    }
  }
  return lines;
}

/**
 * 创建 wiki_read toolkit。所有操作以 `wikiRoot` 为根,read-only,
 * 命令白名单(ls / cat / grep / find / head / tail)。
 *
 * pet 装备这套 toolkit 后,可以自主检索 wiki,Studio 不指定文件路径。
 */
export function createWikiReadToolkit(wikiRoot: string): StructuredTool[] {
  const root = path.resolve(wikiRoot);

  const ls = tool(
    async ({ path: target }) => {
      try {
        const absolute = ensureInsideRoot(root, target ?? '.');
        const stat = await fs.stat(absolute);
        if (stat.isFile()) {
          return path.relative(root, absolute);
        }
        const lines = await readDirRecursive(absolute, root, 0);
        return truncate(lines.sort().join('\n') || '(empty)');
      } catch (error) {
        return `error: ${(error as Error).message}`;
      }
    },
    {
      name: 'wiki_read_ls',
      description: '列出 wiki 目录或子目录内容(递归),路径相对 wiki 根目录。不传 path 列根目录。',
      schema: z.object({
        path: z.string().optional().describe('相对 wiki 根目录的路径,可选,默认为根'),
      }),
    },
  );

  const cat = tool(
    async ({ path: target }) => {
      try {
        const absolute = ensureInsideRoot(root, target);
        const content = await fs.readFile(absolute, 'utf8');
        return truncate(content);
      } catch (error) {
        return `error: ${(error as Error).message}`;
      }
    },
    {
      name: 'wiki_read_cat',
      description: '读取 wiki 中文件的完整内容。路径相对 wiki 根目录。',
      schema: z.object({
        path: z.string().describe('相对 wiki 根目录的文件路径'),
      }),
    },
  );

  const grep = tool(
    async ({ pattern, path: target }) => {
      try {
        const absolute = ensureInsideRoot(root, target ?? '.');
        // 使用 ripgrep / grep 子进程,只读取文本结果
        const { stdout } = await execFileAsync(
          'grep',
          ['-rIn', '--', pattern, absolute],
          { maxBuffer: MAX_OUTPUT_BYTES * 2 },
        );
        // 把绝对路径转换回相对路径
        const replaced = stdout.replace(new RegExp(escapeRegExp(`${root}/`), 'g'), '');
        return truncate(replaced || '(no matches)');
      } catch (error: unknown) {
        if (error && typeof error === 'object' && 'code' in error && (error as { code: number }).code === 1) {
          return '(no matches)';
        }
        return `error: ${(error as Error).message}`;
      }
    },
    {
      name: 'wiki_read_grep',
      description: 'wiki 内全文搜索(基本正则,行号显示)。范围可指定子路径。',
      schema: z.object({
        pattern: z.string().describe('搜索模式(POSIX 基础正则)'),
        path: z.string().optional().describe('搜索范围,相对 wiki 根目录,默认全 wiki'),
      }),
    },
  );

  const find = tool(
    async ({ name, ext }) => {
      try {
        const args = ['-type', 'f'];
        if (name) args.push('-name', name);
        if (ext) args.push('-iname', `*.${ext.replace(/^\./, '')}`);
        const { stdout } = await execFileAsync('find', [root, ...args], {
          maxBuffer: MAX_OUTPUT_BYTES * 2,
        });
        const lines = stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => path.relative(root, line));
        return truncate(lines.sort().join('\n') || '(no matches)');
      } catch (error) {
        return `error: ${(error as Error).message}`;
      }
    },
    {
      name: 'wiki_read_find',
      description: '按文件名或扩展名查找 wiki 内文件。',
      schema: z.object({
        name: z.string().optional().describe('文件名 glob,例如 "script-*.md"'),
        ext: z.string().optional().describe('扩展名,例如 "md" 或 "jpg"'),
      }),
    },
  );

  const head = tool(
    async ({ path: target, n }) => {
      try {
        const absolute = ensureInsideRoot(root, target);
        const content = await fs.readFile(absolute, 'utf8');
        const lines = content.split('\n').slice(0, n ?? 20);
        return truncate(lines.join('\n'));
      } catch (error) {
        return `error: ${(error as Error).message}`;
      }
    },
    {
      name: 'wiki_read_head',
      description: '读取 wiki 文件前 N 行(默认 20)。',
      schema: z.object({
        path: z.string().describe('相对 wiki 根目录的文件路径'),
        n: z.number().int().positive().optional().describe('行数,默认 20'),
      }),
    },
  );

  const tail = tool(
    async ({ path: target, n }) => {
      try {
        const absolute = ensureInsideRoot(root, target);
        const content = await fs.readFile(absolute, 'utf8');
        const lines = content.split('\n');
        const tailLines = lines.slice(Math.max(0, lines.length - (n ?? 20)));
        return truncate(tailLines.join('\n'));
      } catch (error) {
        return `error: ${(error as Error).message}`;
      }
    },
    {
      name: 'wiki_read_tail',
      description: '读取 wiki 文件最后 N 行(默认 20)。',
      schema: z.object({
        path: z.string().describe('相对 wiki 根目录的文件路径'),
        n: z.number().int().positive().optional().describe('行数,默认 20'),
      }),
    },
  );

  return [ls, cat, grep, find, head, tail];
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
