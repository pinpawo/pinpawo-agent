import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { defineToolkit } from '../types/toolkit';
import type { AgentToolkit, NamedStructuredTool, ToolkitOperationMetadata } from '../types/toolkit';

export type WebSearchResult = {
  title: string;
  url: string;
  snippet?: string | null;
  score?: number | null;
};

export type WebSearchToolOptions = {
  search?: (input: {
    query: string;
    limit?: number;
  }) => Promise<WebSearchResult[]>;
  unavailableMessage?: string;
};

function formatUnavailableMessage(message?: string) {
  return message ?? '当前还没有接入可用的 web search provider。';
}

function readInput(input: unknown) {
  const value = input && typeof input === 'object'
    ? input as { query?: unknown; limit?: unknown }
    : {};
  return {
    query: typeof value.query === 'string' && value.query.trim()
      ? value.query.trim()
      : null,
    limit: typeof value.limit === 'number' && Number.isFinite(value.limit)
      ? value.limit
      : null,
  };
}

function parseJsonObject(output: unknown): Record<string, unknown> | null {
  if (typeof output !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(output) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

const webSearchToolOperations = {
  search_web: {
    title: '搜索网页',
    summarizeInput: (input: unknown) => {
      const { query, limit } = readInput(input);
      return {
        target: query ?? undefined,
        summary: query ?? '搜索网页',
        details: {
          limit: limit ?? 5,
        },
      };
    },
    summarizeOutput: (output: unknown) => {
      const parsed = parseJsonObject(output);
      if (!parsed) {
        return null;
      }
      if (parsed.ok === false) {
        return {
          summary: typeof parsed.reason === 'string' ? parsed.reason : '网页搜索不可用',
        };
      }
      return typeof parsed.count === 'number'
        ? { summary: `找到 ${parsed.count} 条结果` }
        : null;
    },
  },
} satisfies Record<string, ToolkitOperationMetadata>;

export function createWebSearchTool(options: WebSearchToolOptions = {}): StructuredTool {
  return tool(
    async ({ query, limit }) => {
      if (!options.search) {
        return JSON.stringify({
          ok: false,
          reason: 'web-search-unavailable',
          hint: formatUnavailableMessage(options.unavailableMessage),
        });
      }

      try {
        const results = await options.search({ query, limit });
        return JSON.stringify({
          ok: true,
          count: results.length,
          results,
        });
      } catch (error) {
        return JSON.stringify({
          ok: false,
          reason: 'web-search-failed',
          hint: error instanceof Error ? error.message : String(error),
        });
      }
    },
    {
      name: 'search_web',
      description: '搜索外部网络获取最新信息。只在用户明确需要实时、外部世界或最新信息时调用。',
      schema: z.object({
        query: z.string().min(1).describe('搜索关键词或问题。'),
        limit: z.number().int().min(1).max(10).optional().describe('最多返回多少条结果，默认 5。'),
      }),
    },
  );
}

export function createWebSearchToolkit(options: WebSearchToolOptions = {}): AgentToolkit {
  const webSearchTool = createWebSearchTool(options) as NamedStructuredTool<'search_web'>;
  return defineToolkit({
    name: 'web_search',
    description: '搜索外部网络获取最新信息。',
    tools: [webSearchTool] as const,
    operations: webSearchToolOperations,
  });
}
