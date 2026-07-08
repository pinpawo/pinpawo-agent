import type { AIMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { AgentCapability } from '../../types/capability';
import type { CapabilityCandidate } from './types';

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
