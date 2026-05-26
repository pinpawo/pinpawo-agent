import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

export type MemorySearchResult = {
  id?: string | null;
  type?: string | null;
  content: string;
  score?: number | null;
  createdAt?: string | null;
};

export type MemoriesToolOptions = {
  searchMemories?: (input: {
    query: string;
    limit?: number;
  }) => Promise<MemorySearchResult[]>;
  unavailableMessage?: string;
};

function formatUnavailableMessage(message?: string) {
  return message ?? '当前还没有接入可搜索的 memory store。';
}

export function createMemoriesTool(options: MemoriesToolOptions = {}): StructuredTool {
  return tool(
    async ({ query, limit }) => {
      if (!options.searchMemories) {
        return JSON.stringify({
          ok: false,
          reason: 'memories-unavailable',
          hint: formatUnavailableMessage(options.unavailableMessage),
        });
      }

      try {
        const memories = await options.searchMemories({ query, limit });
        return JSON.stringify({
          ok: true,
          count: memories.length,
          memories,
        });
      } catch (error) {
        return JSON.stringify({
          ok: false,
          reason: 'memory-search-failed',
          hint: error instanceof Error ? error.message : String(error),
        });
      }
    },
    {
      name: 'get_memories',
      description: '搜索与当前问题相关的记忆、偏好或过往事实。只有在当前对话确实依赖过去信息时才调用。',
      schema: z.object({
        query: z.string().min(1).describe('要检索的记忆主题，例如“我喜欢什么”“上次答应过什么”“最近提过的偏好”。'),
        limit: z.number().int().min(1).max(10).optional().describe('最多返回多少条记忆，默认 5。'),
      }),
    },
  );
}
