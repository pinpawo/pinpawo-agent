import { tool, type StructuredTool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { GENERAL_CAPABILITY_NAME } from '../../../types/capability';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import {
  CAPABILITY_REGISTRY_BACKEND,
  createCapabilityRegistryDocuments,
  type CapabilityRegistryBackend,
} from './registryDocuments';
import {
  CapabilityPlannerWorkspaceReader,
  PlannerFileToolError,
  stablePlannerFileToolError,
} from './workspaceReader';

export const CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME = 'grep_search';
const CAPABILITY_PLANNER_GREP_SEARCH_TOOL_DESCRIPTION = 'Planner exploration action. Discover potentially relevant Capabilities in the configured immutable registry. The query accepts 1-3 short literal alternatives separated with | for OR matching; spaces remain part of one literal phrase. Each match contains the complete CAPABILITY.md document. If no literal match exists and General is registered, fallback contains its complete verified document. This is not a terminal action.';

const DEFAULT_MAX_DOCUMENT_READ_BYTES = 64 * 1024;
const MAX_GREP_RESULTS = 50;
const MAX_GREP_QUERY_TERMS = 3;
const MAX_GREP_QUERY_CHARS = 160;
const MAX_GREP_RESULT_BYTES = 64 * 1024;
export const CAPABILITY_PLANNER_MAX_GREP_SEARCH_CALLS = 3;

export type CapabilityPlannerFileExplorer = {
  /**
   * Framework-private tools for a Capability Planner Agent. They are not an
   * AgentToolkit and must never enter Capability authorization or review.
   */
  readonly tools: readonly StructuredTool[];
  readonly didReachDocumentReadLimit: () => boolean;
  readonly search: (
    query: string,
    signal?: AbortSignal,
  ) => Promise<string>;
};

export function createCapabilityPlannerGrepSearchTool<TState>(
  search: (
    query: string,
    runtime: ToolRuntime<TState>,
  ) => Promise<string>,
) {
  return tool(
    async ({ query }: { query: string }, runtime: ToolRuntime<TState>) =>
      search(query, runtime),
    {
      name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
      description: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_DESCRIPTION,
      schema: z.object({
        query: z.string().min(1).max(MAX_GREP_QUERY_CHARS)
          .describe('One to three short literal alternatives joined with | for OR matching. Spaces remain part of one literal phrase.'),
      }),
    },
  );
}

function utf8Bytes(content: string) {
  return Buffer.byteLength(content, 'utf8');
}

function formatSuccess(
  data: unknown,
) {
  return JSON.stringify({
    ok: true,
    data,
  });
}

function formatError(error: unknown) {
  const stable = stablePlannerFileToolError(error);
  return JSON.stringify({
    ok: false,
    error: {
      code: stable.code,
      message: stable.message,
    },
  });
}

function grepQueryTerms(query: string) {
  const terms = query
    .split('|')
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) {
    throw new PlannerFileToolError(
      'invalid_query',
      'grep query must contain at least one non-empty term',
    );
  }
  if (terms.length > MAX_GREP_QUERY_TERMS) {
    throw new PlannerFileToolError(
      'invalid_query',
      `grep query must contain at most ${String(MAX_GREP_QUERY_TERMS)} alternatives separated with |`,
    );
  }
  if (terms.some((term) => /[\0\r\n]/.test(term))) {
    throw new PlannerFileToolError(
      'invalid_query',
      'grep query alternatives must be single-line text',
    );
  }
  return terms.map((term) => term.toLowerCase());
}

export function createCapabilityPlannerFileExplorer(params: {
  workspace: CapabilityDocumentWorkspace;
  registryBackend?: CapabilityRegistryBackend;
  maxDocumentReadBytes?: number;
}): CapabilityPlannerFileExplorer {
  const { workspace } = params;
  const registryBackend = params.registryBackend
    ?? CAPABILITY_REGISTRY_BACKEND.FILESYSTEM;
  const registryDocuments = createCapabilityRegistryDocuments({
    workspace,
    backend: registryBackend,
  });
  const workspaceReader = new CapabilityPlannerWorkspaceReader(workspace);
  const maxDocumentReadBytes = params.maxDocumentReadBytes
    ?? DEFAULT_MAX_DOCUMENT_READ_BYTES;
  if (!Number.isSafeInteger(maxDocumentReadBytes) || maxDocumentReadBytes <= 0) {
    throw new Error('Capability Planner maxDocumentReadBytes must be a positive integer');
  }
  let consumedDocumentReadBytes = 0;
  let documentReadLimitReached = false;

  const readGeneralFallback = async (
    signal?: AbortSignal,
  ) => {
    const entry = workspace.entries.find(
      ({ capabilityName }) => capabilityName === GENERAL_CAPABILITY_NAME,
    );
    if (!entry) return null;
    const content = await workspaceReader.readDocument(entry.relativePath, signal);
    const fallback = {
      capabilityName: GENERAL_CAPABILITY_NAME,
      path: entry.relativePath,
      content,
      matchedTerms: [],
      reason: 'general_fallback',
    } as const;
    const fallbackBytes = utf8Bytes(content);
    const remainingDocumentReadBytes = Math.max(
      0,
      maxDocumentReadBytes - consumedDocumentReadBytes,
    );
    if (
      fallbackBytes > remainingDocumentReadBytes
      || fallbackBytes > MAX_GREP_RESULT_BYTES
    ) {
      documentReadLimitReached = true;
      throw new PlannerFileToolError(
        'planning_limit_reached',
        'Capability Planner General fallback document exceeds the remaining read limit.',
      );
    }
    consumedDocumentReadBytes += fallbackBytes;
    if (consumedDocumentReadBytes >= maxDocumentReadBytes) {
      documentReadLimitReached = true;
    }
    return fallback;
  };

  const search = async (
    query: string,
    signal: AbortSignal | undefined,
  ) => {
    try {
      const normalizedTerms = grepQueryTerms(query);
      const remainingDocumentReadBytes = Math.max(
        0,
        maxDocumentReadBytes - consumedDocumentReadBytes,
      );
      if (remainingDocumentReadBytes === 0) {
        documentReadLimitReached = true;
        throw new PlannerFileToolError(
          'planning_limit_reached',
          'Capability Planner document read limit is reached.',
        );
      }
      const result = await registryDocuments.search({
        terms: normalizedTerms,
        maxResults: MAX_GREP_RESULTS,
        maxResultBytes: Math.min(
          remainingDocumentReadBytes,
          MAX_GREP_RESULT_BYTES,
        ),
        signal,
      });
      if (result.matches.length === 0 && result.stoppedBy === 'result_size') {
        documentReadLimitReached = true;
        throw new PlannerFileToolError(
          'planning_limit_reached',
          'Capability Planner search result cannot fit the first matching document.',
        );
      }
      consumedDocumentReadBytes += result.matches.reduce(
        (total, match) => total + utf8Bytes(match.content),
        0,
      );
      if (consumedDocumentReadBytes >= maxDocumentReadBytes) {
        documentReadLimitReached = true;
      }
      const fallback = result.matches.length === 0
        ? await readGeneralFallback(signal)
        : null;
      return formatSuccess(
        {
          matches: result.matches,
          ...(fallback ? { fallback } : {}),
          complete: result.complete,
          stoppedBy: result.stoppedBy,
        },
      );
    } catch (error) {
      return formatError(error);
    }
  };

  const grepSearch = createCapabilityPlannerGrepSearchTool(
    (query, runtime) => search(query, runtime.signal),
  );

  return Object.freeze({
    tools: Object.freeze([grepSearch]),
    didReachDocumentReadLimit: () => documentReadLimitReached,
    search,
  });
}
