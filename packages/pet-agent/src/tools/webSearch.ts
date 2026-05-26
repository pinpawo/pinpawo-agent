import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

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
