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

export const CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME = 'capability_search';
const CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_DESCRIPTION = 'Progressively disclose specific Capability documents by literal terms. Each match contains the complete CAPABILITY.md document. An unmatched result reports the remaining search opportunity and mode-specific planning guidance.';

const DEFAULT_MAX_DOCUMENT_READ_BYTES = 64 * 1024;
const MAX_CAPABILITY_SEARCH_RESULTS = 50;
const MAX_CAPABILITY_SEARCH_TERM_CHARS = 40;
const MAX_CAPABILITY_SEARCH_TERM_WORDS = 4;
const MAX_CAPABILITY_SEARCH_RESULT_BYTES = 64 * 1024;
export type CapabilityPlannerFileExplorer = {
  /**
   * Framework-private tools for a Capability Planner Agent. They are not an
   * AgentToolkit and must never enter Capability authorization or review.
   */
  readonly tools: readonly StructuredTool[];
  readonly didReachDocumentReadLimit: () => boolean;
  readonly search: (
    terms: readonly string[],
    signal?: AbortSignal,
  ) => Promise<string>;
  /**
   * Read the well-known default Capability into the Planner's private input
   * context. It is not a search result and never enters parent graph state.
   */
  readonly readDefaultCapability: (
    signal?: AbortSignal,
  ) => Promise<CapabilityPlannerDefaultCapability | null>;
};

export type CapabilityPlannerDefaultCapability = {
  readonly capabilityName: typeof GENERAL_CAPABILITY_NAME;
  readonly path: string;
  readonly content: string;
};

export function createCapabilityPlannerSearchTool<
  TState = Record<string, unknown>,
>(
  search: (
    terms: readonly string[],
    state: ToolRuntime<TState>['state'],
    signal?: AbortSignal,
  ) => Promise<string>,
) {
  return tool(
    async ({ terms }: { terms: string[] }, runtime: ToolRuntime<TState>) =>
      search(terms, runtime.state, runtime.signal),
    {
      name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
      description: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_DESCRIPTION,
      schema: z.object({
        terms: z.array(
          z.string().trim().min(1).max(MAX_CAPABILITY_SEARCH_TERM_CHARS)
            .refine(
              (term) => term.split(/\s+/u).length <= MAX_CAPABILITY_SEARCH_TERM_WORDS,
              'Each term must be a literal word or short phrase, not a search instruction.',
            )
            .describe('A literal word or short phrase expected in a Capability name, description, or document; not an action or search instruction.'),
        ).min(1)
          .describe('Alternative terms for one Capability. Any matching term may select a document.'),
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

function normalizeCapabilitySearchTerms(input: readonly string[]) {
  const terms = input
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) {
    throw new PlannerFileToolError(
      'invalid_query',
      'Capability search must contain at least one non-empty term',
    );
  }
  if (terms.some((term) => /[\0\r\n]/.test(term))) {
    throw new PlannerFileToolError(
      'invalid_query',
      'Capability search terms must be single-line text',
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

  const readDefaultCapability = async (
    signal?: AbortSignal,
  ): Promise<CapabilityPlannerDefaultCapability | null> => {
    const entry = workspace.entries.find(
      ({ capabilityName }) => capabilityName === GENERAL_CAPABILITY_NAME,
    );
    if (!entry) return null;
    const content = await workspaceReader.readDocument(entry.relativePath, signal);
    const defaultCapability = {
      capabilityName: GENERAL_CAPABILITY_NAME,
      path: entry.relativePath,
      content,
    } as const;
    const defaultCapabilityBytes = utf8Bytes(content);
    const remainingDocumentReadBytes = Math.max(
      0,
      maxDocumentReadBytes - consumedDocumentReadBytes,
    );
    if (
      defaultCapabilityBytes > remainingDocumentReadBytes
      || defaultCapabilityBytes > MAX_CAPABILITY_SEARCH_RESULT_BYTES
    ) {
      documentReadLimitReached = true;
      throw new PlannerFileToolError(
        'planning_limit_reached',
        'Capability Planner default Capability document exceeds the remaining read limit.',
      );
    }
    consumedDocumentReadBytes += defaultCapabilityBytes;
    if (consumedDocumentReadBytes >= maxDocumentReadBytes) {
      documentReadLimitReached = true;
    }
    return defaultCapability;
  };

  const search = async (
    terms: readonly string[],
    signal: AbortSignal | undefined,
  ) => {
    try {
      const normalizedTerms = normalizeCapabilitySearchTerms(terms);
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
        maxResults: MAX_CAPABILITY_SEARCH_RESULTS,
        maxResultBytes: Math.min(
          remainingDocumentReadBytes,
          MAX_CAPABILITY_SEARCH_RESULT_BYTES,
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
      return formatSuccess(
        {
          matches: result.matches,
          complete: result.complete,
          stoppedBy: result.stoppedBy,
        },
      );
    } catch (error) {
      return formatError(error);
    }
  };

  const capabilitySearch = createCapabilityPlannerSearchTool(
    (terms, _state, signal) => search(terms, signal),
  );

  return Object.freeze({
    tools: Object.freeze([capabilitySearch]),
    didReachDocumentReadLimit: () => documentReadLimitReached,
    search,
    readDefaultCapability,
  });
}
