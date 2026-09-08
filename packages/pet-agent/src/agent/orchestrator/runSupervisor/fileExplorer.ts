import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import {
  CAPABILITY_REGISTRY_BACKEND,
  createCapabilityRegistryDocuments,
  type CapabilityRegistryBackend,
  type CapabilityRegistrySearchResult,
} from './registryDocuments';
import {
  RunSupervisorWorkspaceReader,
  SupervisorFileToolError,
  stableSupervisorFileToolError,
  type SupervisorFileToolErrorCode,
} from './workspaceReader';

export const RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_NAME = 'capability_details';
const RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_DESCRIPTION = '按 manifest 中的完整名称披露 Capability 详情。用于了解已知能力的具体职责、约束和使用说明，不搜索其他能力，也不执行任务。manifest 和已披露文档可直接用于安排计划；需要具体细节时才调用。可一次提供多个名称。已披露的名称只返回状态，不重复文档。';

const DEFAULT_MAX_DOCUMENT_READ_BYTES = 64 * 1024;
const MAX_CAPABILITY_SEARCH_RESULTS = 50;
const MAX_CAPABILITY_SEARCH_TERM_CHARS = 80;
const MAX_CAPABILITY_SEARCH_RESULT_BYTES = 64 * 1024;
export type RunSupervisorFileExplorer = {
  readonly didReachDocumentReadLimit: () => boolean;
  readonly search: (
    terms: readonly string[],
    signal?: AbortSignal,
  ) => Promise<RunSupervisorSearchResult>;
  /** Read already-disclosed documents for the current Supervisor invocation. */
  readonly readCapabilities: (
    capabilityNames: readonly string[],
    signal?: AbortSignal,
  ) => Promise<RunSupervisorCapabilityDocument[]>;
};

export type RunSupervisorCapabilityDocument = {
  readonly capabilityName: string;
  readonly path: string;
  readonly content: string;
};

export type RunSupervisorSearchResult = {
  readonly ok: true;
  readonly data: CapabilityRegistrySearchResult;
} | {
  readonly ok: false;
  readonly error: {
    readonly code: SupervisorFileToolErrorCode;
    readonly message: string;
  };
};

export function createRunSupervisorDetailsTool<TState = Record<string, unknown>>(
  details: (names: readonly string[], runtime: ToolRuntime<TState>) => Promise<unknown>,
) {
  return tool(async ({ names }: { names: string[] }, runtime: ToolRuntime<TState>) => details(names, runtime), {
    name: RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_NAME,
    description: RUN_SUPERVISOR_CAPABILITY_DETAILS_TOOL_DESCRIPTION,
    schema: z.object({ names: z.array(z.string().trim().min(1).max(200)).min(1)
      .describe('manifest 中需要进一步了解的 Capability 完整名称；精确匹配，不接受关键词或模糊查询。') }).strict(),
  });
}

function utf8Bytes(content: string) {
  return Buffer.byteLength(content, 'utf8');
}

function searchError(error: unknown): RunSupervisorSearchResult {
  const stable = stableSupervisorFileToolError(error);
  return {
    ok: false,
    error: {
      code: stable.code,
      message: stable.message,
    },
  };
}

function normalizeCapabilitySearchTerms(input: readonly string[]) {
  const terms = input
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) {
    throw new SupervisorFileToolError(
      'invalid_query',
      'Capability search must contain at least one non-empty term',
    );
  }
  if (terms.some((term) => /[\0\r\n]/.test(term))) {
    throw new SupervisorFileToolError(
      'invalid_query',
      'Capability search terms must be single-line text',
    );
  }
  return terms.map((term) => term.toLowerCase());
}

export function createRunSupervisorFileExplorer(params: {
  workspace: CapabilityDocumentWorkspace;
  registryBackend?: CapabilityRegistryBackend;
  maxDocumentReadBytes?: number;
}): RunSupervisorFileExplorer {
  const { workspace } = params;
  const registryBackend = params.registryBackend
    ?? CAPABILITY_REGISTRY_BACKEND.FILESYSTEM;
  const registryDocuments = createCapabilityRegistryDocuments({
    workspace,
    backend: registryBackend,
  });
  const workspaceReader = new RunSupervisorWorkspaceReader(workspace);
  const maxDocumentReadBytes = params.maxDocumentReadBytes
    ?? DEFAULT_MAX_DOCUMENT_READ_BYTES;
  if (!Number.isSafeInteger(maxDocumentReadBytes) || maxDocumentReadBytes <= 0) {
    throw new Error('Run Supervisor maxDocumentReadBytes must be a positive integer');
  }
  let consumedDocumentReadBytes = 0;
  let documentReadLimitReached = false;

  const readCapabilities = async (
    capabilityNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<RunSupervisorCapabilityDocument[]> => {
    const entryByName = new Map(workspace.entries.map((entry) => [
      entry.capabilityName,
      entry,
    ]));
    const documents: RunSupervisorCapabilityDocument[] = [];
    for (const capabilityName of [...new Set(capabilityNames)]) {
      const entry = entryByName.get(capabilityName);
      if (!entry) {
        throw new SupervisorFileToolError(
          'invalid_query',
          `Disclosed Capability "${capabilityName}" is not present in the workspace.`,
        );
      }
      documents.push({
        capabilityName,
        path: entry.relativePath,
        content: await workspaceReader.readDocument(entry.relativePath, signal),
      });
    }
    const documentBytes = documents.reduce(
      (total, document) => total + utf8Bytes(document.content),
      0,
    );
    const remainingDocumentReadBytes = Math.max(
      0,
      maxDocumentReadBytes - consumedDocumentReadBytes,
    );
    if (
      documentBytes > remainingDocumentReadBytes
      || documentBytes > MAX_CAPABILITY_SEARCH_RESULT_BYTES
    ) {
      documentReadLimitReached = true;
      throw new SupervisorFileToolError(
        'supervisor_discovery_limit_reached',
        'Disclosed Capability documents exceed the remaining Supervisor read limit.',
      );
    }
    consumedDocumentReadBytes += documentBytes;
    if (consumedDocumentReadBytes >= maxDocumentReadBytes) {
      documentReadLimitReached = true;
    }
    return documents;
  };

  const search = async (
    terms: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<RunSupervisorSearchResult> => {
    try {
      const normalizedTerms = normalizeCapabilitySearchTerms(terms);
      const remainingDocumentReadBytes = Math.max(
        0,
        maxDocumentReadBytes - consumedDocumentReadBytes,
      );
      if (remainingDocumentReadBytes === 0) {
        documentReadLimitReached = true;
        throw new SupervisorFileToolError(
          'supervisor_discovery_limit_reached',
          'Run Supervisor document read limit is reached.',
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
        throw new SupervisorFileToolError(
          'supervisor_discovery_limit_reached',
          'Run Supervisor search result cannot fit the first matching document.',
        );
      }
      consumedDocumentReadBytes += result.matches.reduce(
        (total, match) => total + utf8Bytes(match.content),
        0,
      );
      if (consumedDocumentReadBytes >= maxDocumentReadBytes) {
        documentReadLimitReached = true;
      }
      return { ok: true, data: result };
    } catch (error) {
      return searchError(error);
    }
  };

  return Object.freeze({
    didReachDocumentReadLimit: () => documentReadLimitReached,
    search,
    readCapabilities,
  });
}
