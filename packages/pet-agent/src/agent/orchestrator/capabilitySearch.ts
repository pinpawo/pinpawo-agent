import type { AIMessage } from '@langchain/core/messages';
import { ToolMessage, type ToolCall } from '@langchain/core/messages/tool';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import type { AgentCapability } from '../../types/capability';
import type { CapabilityCandidate } from './types';
import { setPinpetMeta } from './messageLanes';

export const CAPABILITY_SEARCH_TOOL_NAME = 'capability_search';

const CapabilitySearchInputSchema = z.object({
  query: z.string().min(1).describe('用于搜索 capability 的关键词或短语。多个词用 | 分隔，例如：宠物动态|发帖|内容生成。'),
});

const ORCHESTRATOR_INTERNAL_LANE = 'orchestrator';

function readRuntimeCapabilities(runtime: ToolRuntime): AgentCapability[] {
  const configurable = runtime.config?.configurable ?? runtime.configurable ?? {};
  const capabilities = (configurable as { capabilities?: unknown }).capabilities;
  return Array.isArray(capabilities) ? capabilities as AgentCapability[] : [];
}

export const capabilitySearchTool = tool(
  async ({ query }: z.infer<typeof CapabilitySearchInputSchema>, runtime: ToolRuntime) => {
    const searchQuery = query.trim();
    const candidates = searchQuery ? searchCapabilities(searchQuery, readRuntimeCapabilities(runtime)) : [];
    const toolCallId = runtime.toolCall?.id || runtime.toolCallId;
    if (!toolCallId) {
      throw new Error('capability_search requires a tool call id');
    }

    const toolMessage = new ToolMessage({
      content: candidates.length > 0
        ? `Found ${candidates.length} capability candidate(s).`
        : 'No capability candidates found.',
      name: CAPABILITY_SEARCH_TOOL_NAME,
      tool_call_id: toolCallId,
    });
    setPinpetMeta(toolMessage, { lane: ORCHESTRATOR_INTERNAL_LANE });

    return new Command({
      update: {
        messages: [toolMessage],
        runNextDelegation: null,
        runCapabilitySearchState: {
          query: searchQuery || null,
          attempted: true,
          candidates,
        },
      },
    });
  },
  {
    name: CAPABILITY_SEARCH_TOOL_NAME,
    description: [
      '搜索可用于处理当前用户业务目标的 capability 候选。',
      '输入 query：用一句话或关键词描述用户想完成的业务目标；多个词或短语可用 | 分隔。',
      '输出：更新 orchestrator 的 capability 候选状态；没有匹配时记录为空候选。',
    ].join('\n'),
    schema: CapabilitySearchInputSchema,
  },
);

export function readModelToolCalls(response: AIMessage): ToolCall[] {
  const normalizedToolCalls = response.tool_calls;
  if (Array.isArray(normalizedToolCalls)) {
    return normalizedToolCalls;
  }
  return [];
}

export const readRouteToolCalls = readModelToolCalls;

function normalizeSearchText(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

export function extractCapabilityKeywords(text: string): string[] {
  return normalizeSearchText(text)
    .split(/[\s,，、;；/。.!！？?：:()（）[\]【】"'“”‘’|+-]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

export function splitCapabilitySearchTerms(query: string): string[] {
  const rawTerms = query
    .split('|')
    .flatMap((part) => [part, ...part.split(/[\s,，、;；/]+/u)])
    .map((part) => part.trim())
    .filter(Boolean);

  const normalized = new Map<string, string>();
  for (const term of rawTerms) {
    const key = normalizeSearchText(term);
    if (!normalized.has(key)) {
      normalized.set(key, term);
    }
  }
  return [...normalized.values()];
}

function scoreCapabilityMatch(capability: AgentCapability, term: string): number {
  const normalizedTerm = normalizeSearchText(term);
  if (!normalizedTerm) return 0;

  const normalizedName = normalizeSearchText(capability.name);
  const normalizedDescription = normalizeSearchText(capability.description);
  const compactTerm = normalizedTerm.replace(/\s+/g, '');
  const compactHaystack = `${normalizedName} ${normalizedDescription}`.replace(/\s+/g, '');

  if (normalizedName === normalizedTerm) return 12;
  if (normalizedName.includes(normalizedTerm)) return 7;
  if (normalizedDescription.includes(normalizedTerm)) return 4;
  if (compactTerm.length >= 2 && compactHaystack.includes(compactTerm)) return 3;

  const containedKeywordCount = extractCapabilityKeywords(`${capability.name} ${capability.description}`)
    .filter((keyword) => compactTerm.includes(keyword.replace(/\s+/g, '')))
    .length;
  if (containedKeywordCount > 0) {
    return Math.min(6, containedKeywordCount * 2);
  }

  return 0;
}

export function searchCapabilities(query: string, capabilities: AgentCapability[]): CapabilityCandidate[] {
  const terms = splitCapabilitySearchTerms(query);
  if (terms.length === 0) return [];

  return capabilities
    .map((capability) => {
      const matchedTerms: string[] = [];
      let score = 0;
      for (const term of terms) {
        const termScore = scoreCapabilityMatch(capability, term);
        if (termScore > 0) {
          matchedTerms.push(term);
          score += termScore;
        }
      }
      return {
        name: capability.name,
        description: capability.description,
        score,
        matchedTerms,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 5);
}
