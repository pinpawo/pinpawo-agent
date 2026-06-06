import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { defineToolkit } from '../types/toolkit';
import type { AgentToolkit, NamedStructuredTool, ToolkitOperationMetadata } from '../types/toolkit';

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

const memoriesToolOperations = {
  get_memories: {
    kind: 'memory.search',
    title: '搜索记忆',
    summarizeInput: (input: unknown) => {
      const { query, limit } = readInput(input);
      return {
        target: query ?? undefined,
        summary: query ?? '搜索记忆',
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
          summary: typeof parsed.reason === 'string' ? parsed.reason : '记忆搜索不可用',
        };
      }
      return typeof parsed.count === 'number'
        ? { summary: `找到 ${parsed.count} 条记忆` }
        : null;
    },
  },
} satisfies Record<string, ToolkitOperationMetadata>;

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

export function createMemoriesToolkit(options: MemoriesToolOptions = {}): AgentToolkit {
  const memoriesTool = createMemoriesTool(options) as NamedStructuredTool<'get_memories'>;
  return defineToolkit({
    name: 'memory',
    description: '搜索与当前问题相关的记忆、偏好或过往事实。',
    tools: [memoriesTool] as const,
    operations: memoriesToolOperations,
  });
}
