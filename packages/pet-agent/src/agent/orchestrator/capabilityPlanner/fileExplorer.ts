import { tool, type StructuredTool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import {
  CAPABILITY_REGISTRY_BACKEND,
  createCapabilityRegistryDocuments,
  type CapabilityRegistryBackend,
} from './registryDocuments';
import {
  CAPABILITY_PLANNER_DOCUMENT_PATH_MAX_CHARS,
  PlannerFileToolError,
  stablePlannerFileToolError,
} from './workspaceReader';

export const CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME = 'grep_search';
export const CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME = 'view_file_chunk';

const DEFAULT_MAX_DOCUMENT_READ_BYTES = 64 * 1024;
const MAX_GREP_RESULTS = 50;
const MAX_GREP_QUERY_TERMS = 3;
const MAX_GREP_QUERY_CHARS = 160;
const MAX_GREP_LINE_BYTES = 2_000;
const MAX_GREP_RESULT_BYTES = 24 * 1024;
const DEFAULT_VIEW_LINES = 200;
const MAX_VIEW_LINES = 400;
const MAX_VIEW_RESULT_BYTES = 32 * 1024;

export type CapabilityPlannerFileExplorer = {
  /**
   * Framework-private tools for a Capability Planner Agent. They are not an
   * AgentToolkit and must never enter Capability authorization or review.
   */
  readonly tools: readonly StructuredTool[];
  readonly didReachDocumentReadLimit: () => boolean;
};

function utf8Bytes(content: string) {
  return Buffer.byteLength(content, 'utf8');
}

function truncateUtf8(content: string, maxBytes: number) {
  if (utf8Bytes(content) <= maxBytes) return content;
  if (maxBytes <= 0) return '';

  const codePoints = Array.from(content);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(codePoints.slice(0, middle).join('')) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return codePoints.slice(0, low).join('');
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
  const maxDocumentReadBytes = params.maxDocumentReadBytes
    ?? DEFAULT_MAX_DOCUMENT_READ_BYTES;
  if (!Number.isSafeInteger(maxDocumentReadBytes) || maxDocumentReadBytes <= 0) {
    throw new Error('Capability Planner maxDocumentReadBytes must be a positive integer');
  }
  let consumedDocumentReadBytes = 0;
  let documentReadLimitReached = false;

  const grepSearch = tool(
    async ({ query }: {
      query: string;
    }, runtime: ToolRuntime) => {
      try {
        const normalizedTerms = grepQueryTerms(query);
        const result = await registryDocuments.search({
          terms: normalizedTerms,
          maxResults: MAX_GREP_RESULTS,
          maxResultBytes: MAX_GREP_RESULT_BYTES,
          maxLineBytes: MAX_GREP_LINE_BYTES,
          signal: runtime.signal,
        });
        if (result.matches.length === 0 && result.stoppedBy === 'result_size') {
          throw new PlannerFileToolError(
            'planning_limit_reached',
            'Capability Planner search result cannot fit the first matching document.',
          );
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
    },
    {
      name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
      description: 'Search CAPABILITY.md documents in the configured immutable Capability registry for candidate Capabilities. The query accepts 1-3 short literal alternatives separated with | for OR matching; spaces remain part of one literal phrase. Each result contains a matching registry document path and its first matching line.',
      schema: z.object({
        query: z.string().min(1).max(MAX_GREP_QUERY_CHARS)
          .describe('One to three short literal alternatives joined with | for OR matching. Spaces remain part of one literal phrase.'),
      }),
    },
  );

  const viewFileChunk = tool(
    async ({
      path,
      startLine,
      endLine,
    }: {
      path: string;
      startLine?: number;
      endLine?: number;
    }, runtime: ToolRuntime) => {
      try {
        const remainingDocumentReadBytes = Math.max(
          0,
          maxDocumentReadBytes - consumedDocumentReadBytes,
        );
        const availableBytes = Math.min(
          remainingDocumentReadBytes,
          MAX_VIEW_RESULT_BYTES,
        );
        const documentReadLimitBoundsCall = remainingDocumentReadBytes
          <= MAX_VIEW_RESULT_BYTES;
        if (availableBytes === 0) {
          documentReadLimitReached = true;
          throw new PlannerFileToolError(
            'planning_limit_reached',
            'Capability Planner document read limit is reached.',
          );
        }
        const content = await registryDocuments.readDocument(path, runtime.signal);
        const lines = content.split('\n').map((line) => line.replace(/\r$/, ''));
        const start = startLine ?? 1;
        if (start > lines.length) {
          throw new PlannerFileToolError(
            'invalid_range',
            `startLine ${String(start)} is outside the document; totalLines=${String(lines.length)}.`,
          );
        }
        const requestedEnd = endLine ?? start + DEFAULT_VIEW_LINES - 1;
        if (requestedEnd < start || requestedEnd - start + 1 > MAX_VIEW_LINES) {
          throw new PlannerFileToolError(
            'invalid_range',
            `view range must contain between 1 and ${String(MAX_VIEW_LINES)} lines.`,
          );
        }
        const boundedEnd = Math.min(requestedEnd, lines.length);
        const renderedLines: string[] = [];
        let usedBytes = 0;
        let nextStartLine: number | null = null;
        let truncatedLine: number | null = null;
        let stoppedBy: 'document_read_limit' | 'result_limit' | 'line_too_long' | null = null;

        for (let lineNumber = start; lineNumber <= boundedEnd; lineNumber += 1) {
          const rendered = `${String(lineNumber)}: ${lines[lineNumber - 1] ?? ''}`;
          const separatorBytes = renderedLines.length > 0 ? 1 : 0;
          const renderedBytes = utf8Bytes(rendered);
          if (usedBytes + separatorBytes + renderedBytes > availableBytes) {
            if (renderedLines.length === 0) {
              const truncated = truncateUtf8(rendered, availableBytes);
              if (!truncated) {
                throw new PlannerFileToolError(
                  'planning_limit_reached',
                  'Capability Planner document read limit cannot fit the requested line.',
                );
              }
              renderedLines.push(truncated);
              usedBytes = utf8Bytes(truncated);
              truncatedLine = lineNumber;
              stoppedBy = 'line_too_long';
              if (documentReadLimitBoundsCall) {
                documentReadLimitReached = true;
              }
            } else {
              nextStartLine = lineNumber;
              stoppedBy = documentReadLimitBoundsCall
                ? 'document_read_limit'
                : 'result_limit';
              if (documentReadLimitBoundsCall) {
                documentReadLimitReached = true;
              }
            }
            break;
          }
          renderedLines.push(rendered);
          usedBytes += separatorBytes + renderedBytes;
        }

        if (!stoppedBy && boundedEnd < lines.length) {
          nextStartLine = boundedEnd + 1;
          stoppedBy = requestedEnd < lines.length ? 'result_limit' : null;
        }
        const renderedContent = renderedLines.join('\n');
        consumedDocumentReadBytes += utf8Bytes(renderedContent);
        if (consumedDocumentReadBytes >= maxDocumentReadBytes) {
          documentReadLimitReached = true;
        }
        const actualEnd = truncatedLine ?? start + renderedLines.length - 1;
        return formatSuccess(
          {
            path,
            content: renderedContent,
            range: {
              startLine: start,
              endLine: actualEnd,
              totalLines: lines.length,
            },
            nextStartLine,
            complete: stoppedBy === null && actualEnd >= lines.length,
            truncatedLine,
            stoppedBy,
          },
        );
      } catch (error) {
        return formatError(error);
      }
    },
    {
      name: CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
      description: 'Read a bounded, line-numbered chunk of a candidate CAPABILITY.md when its routing summary is insufficient to judge whether it can complete the current task. Use nextStartLine to continue.',
      schema: z.object({
        path: z.string().min(1)
          .max(CAPABILITY_PLANNER_DOCUMENT_PATH_MAX_CHARS)
          .describe('Exact workspace-relative CAPABILITY.md path.'),
        startLine: z.number().int().positive().optional()
          .describe('One-based first line; defaults to 1.'),
        endLine: z.number().int().positive().optional()
          .describe(`One-based inclusive final line; at most ${String(MAX_VIEW_LINES)} lines per call.`),
      }),
    },
  );

  return Object.freeze({
    tools: Object.freeze([grepSearch, viewFileChunk]),
    didReachDocumentReadLimit: () => documentReadLimitReached,
  });
}
