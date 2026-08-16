import { tool, type ToolRuntime } from '@langchain/core/tools';
import type { ToolOperationMetadata } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { readRecord, readString } from '../operationMetadata';
import { resolveUserPath } from './pathUtils';
import { resolveDefaultWorkdir } from '../../runtimeConfig';
import { ripgrepSearchBackend } from './searchBackend';
import { formatGlobSearchResult, formatGrepSearchResult } from './searchFormatter';

const DEFAULT_SEARCH_LIMIT = 100;
const MAX_SEARCH_LIMIT = 200;
const MAX_SEARCH_CONTEXT = 10;

export function createSearchTools(workdir = resolveDefaultWorkdir()) {
  const globSearchTool = tool(
    async ({ path, pattern, limit }: { path?: string; pattern: string; limit?: number }, runtime: ToolRuntime) => {
      try {
        const rootPath = resolveUserPath(path ?? '.', workdir);
        const maxResults = Math.max(1, Math.min(limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT));
        const result = await ripgrepSearchBackend.glob({
          rootPath,
          pattern,
          maxResults: maxResults + 1,
          signal: runtime.signal,
        });
        return formatGlobSearchResult(result, { limit: maxResults });
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : err}`;
      }
    },
    {
      name: 'glob_search',
      description:
        '使用 ripgrep 按 glob 模式递归搜索文件。返回相对搜索根目录的稳定路径；遵守 .gitignore，包含未被忽略的 hidden 文件，但始终排除 .pinpawo、.git、node_modules。结果受数量和 50000 字节上限约束。',
      schema: z.object({
        path: z.string().optional().describe('搜索起点目录，默认 "."'),
        pattern: z.string().min(1).describe('glob 模式，支持 *、**、?，如 *.md、src/**/*.ts'),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_SEARCH_LIMIT)
          .optional()
          .describe(`最多返回多少条，默认 ${DEFAULT_SEARCH_LIMIT}`),
      }),
    },
  );

  const grepSearchTool = tool(
    async (
      {
        path,
        query,
        limit,
        caseSensitive,
        literal,
        glob,
        context,
      }: {
        path?: string;
        query: string;
        limit?: number;
        caseSensitive?: boolean;
        literal?: boolean;
        glob?: string;
        context?: number;
      },
      runtime: ToolRuntime,
    ) => {
      try {
        const rootPath = resolveUserPath(path ?? '.', workdir);
        const maxResults = Math.max(1, Math.min(limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT));
        const contextLines = Math.max(0, Math.min(context ?? 0, MAX_SEARCH_CONTEXT));
        const result = await ripgrepSearchBackend.grep({
          rootPath,
          query,
          literal: literal ?? true,
          caseSensitive: caseSensitive ?? false,
          glob,
          context: contextLines,
          maxMatches: maxResults + 1,
          signal: runtime.signal,
        });
        return formatGrepSearchResult(result, {
          limit: maxResults,
          context: contextLines,
        });
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : err}`;
      }
    },
    {
      name: 'grep_search',
      description:
        '使用 ripgrep 递归搜索文本内容，返回相对搜索根目录的路径、行号和匹配行。默认 literal 匹配；literal=false 启用正则。遵守 .gitignore，包含未被忽略的 hidden 文件，跳过二进制文件，并始终排除 .pinpawo、.git、node_modules。支持 glob/context，结果受匹配数和 50000 字节上限约束。',
      schema: z.object({
        path: z.string().optional().describe('搜索起点目录，默认 "."'),
        query: z.string().min(1).describe('要搜索的文本；literal=false 时为 ripgrep 正则'),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_SEARCH_LIMIT)
          .optional()
          .describe(`最多返回多少个匹配，默认 ${DEFAULT_SEARCH_LIMIT}`),
        caseSensitive: z.boolean().optional().describe('是否区分大小写，默认 false'),
        literal: z.boolean().optional().describe('是否按字面文本搜索，默认 true；false 表示正则'),
        glob: z.string().min(1).optional().describe('限制候选文件的 glob，支持 *、**、?，如 *.ts 或 src/**'),
        context: z
          .number()
          .int()
          .min(0)
          .max(MAX_SEARCH_CONTEXT)
          .optional()
          .describe(`匹配前后文行数，默认 0，最大 ${MAX_SEARCH_CONTEXT}`),
      }),
    },
  );

  return {
    globSearchTool,
    grepSearchTool,
    tools: [globSearchTool, grepSearchTool],
  };
}

export const { globSearchTool, grepSearchTool, tools: searchTools } = createSearchTools();

export const searchOperationMetadata: Record<string, ToolOperationMetadata> = {
  glob_search: {
    title: '找文件',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'path'),
        summary: readString(record, 'pattern'),
      };
    },
  },
  grep_search: {
    title: '搜内容',
    summarizeInput: (input) => {
      const record = readRecord(input);
      return {
        target: readString(record, 'path'),
        summary: readString(record, 'query'),
      };
    },
  },
};
