import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { AIMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import { CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME } from '../src/agent/orchestrator/capabilityPlanner/fileExplorer.ts';

export type CapabilitySearchDiagnostics = {
  searchCalls: number;
  searchRounds: number;
  searchQueries: string[][];
  searchResults: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function readSearchTerms(input: unknown): string[] {
  const parsed = typeof input === 'string' ? parseJson(input) : input;
  if (!isRecord(parsed) || !Array.isArray(parsed.terms)) return [];
  return parsed.terms.filter((term): term is string => typeof term === 'string');
}

function readToolOutput(value: unknown, depth = 0): unknown {
  if (depth > 5) return null;
  if (typeof value === 'string') return parseJson(value);
  if (Array.isArray(value)) {
    const extracted = value.map((item) => readToolOutput(item, depth + 1));
    return extracted.length === 1 ? extracted[0] : extracted;
  }
  if (!isRecord(value)) return value ?? null;
  if ('content' in value) return readToolOutput(value.content, depth + 1);
  if ('messages' in value) return readToolOutput(value.messages, depth + 1);
  if ('update' in value) return readToolOutput(value.update, depth + 1);
  return value;
}

function isCapabilitySearchTool(tool: unknown, runName: string | undefined) {
  if (runName === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME) return true;
  if (!isRecord(tool)) return false;
  if (tool.name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME) return true;
  return Array.isArray(tool.id)
    && tool.id.includes(CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME);
}

function countSearchRounds(output: LLMResult): number {
  return output.generations.filter((generations) => generations.some((generation) =>
    'message' in generation
    && AIMessage.isInstance(generation.message)
    && generation.message.tool_calls?.some(({ name }) =>
      name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
    ),
  )).length;
}

/** Collects invocation-only search evidence from callbacks without checkpointing it. */
export function createCapabilitySearchDiagnosticsCollector() {
  const searchRunIds = new Set<string>();
  const searchQueries: string[][] = [];
  const searchResults: unknown[] = [];
  let searchRounds = 0;
  const callback = BaseCallbackHandler.fromMethods({
    handleToolStart(tool, input, runId, _parentRunId, _tags, _metadata, runName) {
      if (!isCapabilitySearchTool(tool, runName)) return;
      searchRunIds.add(runId);
      searchQueries.push(readSearchTerms(input));
    },
    handleToolEnd(output, runId) {
      if (!searchRunIds.has(runId)) return;
      searchResults.push(readToolOutput(output));
    },
    handleLLMEnd(output) {
      searchRounds += countSearchRounds(output);
    },
  });

  return {
    callback,
    read(): CapabilitySearchDiagnostics {
      return {
        searchCalls: searchQueries.length,
        searchRounds,
        searchQueries: searchQueries.map((terms) => [...terms]),
        searchResults: [...searchResults],
      };
    },
  };
}
