import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { tool } from '@langchain/core/tools';
import type { ToolkitOperationMetadata } from '@pinpawo/pet-agent';
import { z } from 'zod';
import { readRecord, readString } from '../operationMetadata';
import { resolveUserPath } from './pathUtils';
import { walkFiles, wildcardToRegExp } from './fileSystemUtils';

export const globSearchTool = tool(
  async ({ path, pattern, limit }: { path?: string; pattern: string; limit?: number }) => {
    try {
      const rootPath = resolveUserPath(path ?? '.');
      const regex = wildcardToRegExp(pattern);
      const maxResults = Math.max(1, Math.min(limit ?? 50, 200));
      const matches: string[] = [];

      walkFiles(rootPath, (filePath) => {
        const relative = filePath.startsWith(`${rootPath}/`)
          ? filePath.slice(rootPath.length + 1)
          : basename(filePath);
        if (regex.test(relative) || regex.test(basename(filePath))) {
          matches.push(filePath);
        }
        return matches.length < maxResults;
      });

      return matches.length > 0 ? matches.join('\n') : '(no matches)';
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'glob_search',
    description: '按通配符模式递归搜索文件。适合查找某类文件，如 *.md、src/**/*.ts 的简化匹配。返回匹配到的文件路径列表。',
    schema: z.object({
      path: z.string().optional().describe('搜索起点目录，默认 "."'),
      pattern: z.string().describe('通配符模式，支持 * 和 ?'),
      limit: z.number().int().positive().max(200).optional().describe('最多返回多少条，默认 50'),
    }),
  },
);

export const grepSearchTool = tool(
  async ({ path, query, limit, caseSensitive }: {
    path?: string;
    query: string;
    limit?: number;
    caseSensitive?: boolean;
  }) => {
    try {
      const rootPath = resolveUserPath(path ?? '.');
      const maxResults = Math.max(1, Math.min(limit ?? 50, 200));
      const needle = caseSensitive ? query : query.toLowerCase();
      const results: string[] = [];

      walkFiles(rootPath, (filePath) => {
        let content: string;
        try {
          content = readFileSync(filePath, 'utf-8');
        } catch {
          return results.length < maxResults;
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? '';
          const haystack = caseSensitive ? line : line.toLowerCase();
          if (!haystack.includes(needle)) {
            continue;
          }
          results.push(`${filePath}:${i + 1}: ${line}`);
          if (results.length >= maxResults) {
            return false;
          }
        }

        return results.length < maxResults;
      });

      return results.length > 0 ? results.join('\n') : '(no matches)';
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'grep_search',
    description: '递归搜索文件内容，返回匹配行及其文件路径和行号。适合定位某个词、函数名或报错文本。',
    schema: z.object({
      path: z.string().optional().describe('搜索起点目录，默认 "."'),
      query: z.string().describe('要搜索的文本'),
      limit: z.number().int().positive().max(200).optional().describe('最多返回多少条，默认 50'),
      caseSensitive: z.boolean().optional().describe('是否区分大小写，默认 false'),
    }),
  },
);

export const searchToolOperations: Record<string, ToolkitOperationMetadata> = {
  glob_search: {
    kind: 'search.glob',
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
    kind: 'search.grep',
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
