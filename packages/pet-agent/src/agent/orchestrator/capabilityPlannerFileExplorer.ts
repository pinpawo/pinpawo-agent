import {
  isAbsolute,
  posix,
} from 'node:path';
import { tool, type StructuredTool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { CAPABILITY_DOCUMENT_FILE_NAME } from '../../types/capabilityDocument';
import type { CapabilityDocumentWorkspace } from './capabilityDocumentWorkspace';
import {
  CAPABILITY_PLANNER_DOCUMENT_PATH_MAX_CHARS,
  CapabilityPlannerWorkspaceReader,
  PlannerFileToolError,
  stablePlannerFileToolError,
  throwIfPlannerFileExplorationAborted,
} from './capabilityPlannerWorkspaceReader';

export const CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME = 'glob_search';
export const CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME = 'grep_search';
export const CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME = 'view_file_chunk';

const DEFAULT_OBSERVATION_BUDGET_BYTES = 64 * 1024;
const DEFAULT_GLOB_LIMIT = 100;
const MAX_GLOB_LIMIT = 200;
const DEFAULT_GREP_LIMIT = 50;
const MAX_GREP_LIMIT = 100;
const MAX_GLOB_PATTERN_CHARS = 256;
const MAX_GREP_QUERY_CHARS = 500;
const MAX_GLOB_RESULT_BYTES = 16 * 1024;
const MAX_GREP_LINE_BYTES = 2_000;
const MAX_GREP_RESULT_BYTES = 24 * 1024;
const DEFAULT_VIEW_LINES = 200;
const MAX_VIEW_LINES = 400;
const MAX_VIEW_RESULT_BYTES = 32 * 1024;

export type CapabilityPlannerObservationBudgetSnapshot = {
  readonly maxDocumentBytes: number;
  readonly consumedDocumentBytes: number;
  readonly remainingDocumentBytes: number;
  readonly exhausted: boolean;
};

export type CapabilityPlannerFileExplorer = {
  /**
   * Framework-private tools for a Capability Planner Agent. They are not an
   * AgentToolkit and must never enter Capability authorization or review.
   */
  readonly tools: readonly StructuredTool[];
  readonly getObservationBudget: () => CapabilityPlannerObservationBudgetSnapshot;
  readonly hasReachedObservationLimit: () => boolean;
};

type GrepSearchScope = 'summary' | 'document';

class ObservationBudget {
  readonly maxDocumentBytes: number;
  #consumedDocumentBytes = 0;
  #limitReached = false;

  constructor(maxDocumentBytes: number) {
    if (!Number.isSafeInteger(maxDocumentBytes) || maxDocumentBytes <= 0) {
      throw new Error('Capability Planner observation budget must be a positive integer');
    }
    this.maxDocumentBytes = maxDocumentBytes;
  }

  snapshot(): CapabilityPlannerObservationBudgetSnapshot {
    const remainingDocumentBytes = Math.max(
      0,
      this.maxDocumentBytes - this.#consumedDocumentBytes,
    );
    return Object.freeze({
      maxDocumentBytes: this.maxDocumentBytes,
      consumedDocumentBytes: this.#consumedDocumentBytes,
      remainingDocumentBytes,
      exhausted: remainingDocumentBytes === 0,
    });
  }

  consume(bytes: number) {
    if (
      !Number.isSafeInteger(bytes)
      || bytes < 0
      || bytes > this.snapshot().remainingDocumentBytes
    ) {
      throw new PlannerFileToolError(
        'planning_limit_reached',
        'Capability Planner document observation budget is exhausted.',
      );
    }
    this.#consumedDocumentBytes += bytes;
  }

  markLimitReached() {
    this.#limitReached = true;
  }

  hasReachedLimit() {
    return this.#limitReached;
  }
}

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
  toolName: string,
  workspace: CapabilityDocumentWorkspace,
  budget: ObservationBudget,
  data: unknown,
) {
  return JSON.stringify({
    ok: true,
    tool: toolName,
    registryDigest: workspace.registryDigest,
    data,
    observationBudget: budget.snapshot(),
  });
}

function formatError(
  toolName: string,
  workspace: CapabilityDocumentWorkspace,
  budget: ObservationBudget,
  error: unknown,
) {
  const stable = stablePlannerFileToolError(error);
  if (stable.code === 'planning_limit_reached') {
    budget.markLimitReached();
  }
  return JSON.stringify({
    ok: false,
    tool: toolName,
    registryDigest: workspace.registryDigest,
    error: {
      code: stable.code,
      message: stable.message,
    },
    observationBudget: budget.snapshot(),
  });
}

function globExpression(pattern: string) {
  if (
    !pattern
    || pattern.length > MAX_GLOB_PATTERN_CHARS
    || pattern.includes('\0')
    || isAbsolute(pattern)
  ) {
    throw new PlannerFileToolError(
      'invalid_path',
      `glob pattern must be a non-empty relative pattern up to ${String(MAX_GLOB_PATTERN_CHARS)} characters`,
    );
  }

  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? '';
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${expression}$`);
}

function matchesGlob(path: string, pattern: RegExp) {
  return pattern.test(path) || pattern.test(posix.basename(path));
}

function documentBudgetAvailable(
  budget: ObservationBudget,
  perCallMaxBytes: number,
) {
  return Math.min(
    budget.snapshot().remainingDocumentBytes,
    perCallMaxBytes,
  );
}

function consumeDocumentObservation(
  budget: ObservationBudget,
  content: string,
) {
  budget.consume(utf8Bytes(content));
}

function grepQueryTerms(query: string, caseSensitive: boolean) {
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
  return caseSensitive ? terms : terms.map((term) => term.toLowerCase());
}

function grepSearchLines(content: string, scope: GrepSearchScope) {
  const lines = content.split('\n');
  if (scope === 'document') return lines;
  const closingDelimiterIndex = lines.findIndex(
    (line, index) => index > 0 && line.replace(/\r$/, '') === '---',
  );
  return closingDelimiterIndex < 0
    ? lines
    : lines.slice(0, closingDelimiterIndex + 1);
}

export function createCapabilityPlannerFileExplorer(params: {
  workspace: CapabilityDocumentWorkspace;
  maxObservationBytes?: number;
}): CapabilityPlannerFileExplorer {
  const { workspace } = params;
  const reader = new CapabilityPlannerWorkspaceReader(workspace);
  const budget = new ObservationBudget(
    params.maxObservationBytes ?? DEFAULT_OBSERVATION_BUDGET_BYTES,
  );

  const globSearch = tool(
    async ({
      pattern,
      cursor,
      limit,
    }: {
      pattern?: string;
      cursor?: number;
      limit?: number;
    }, runtime: ToolRuntime) => {
      try {
        const availableBytes = documentBudgetAvailable(budget, MAX_GLOB_RESULT_BYTES);
        if (availableBytes === 0) {
          throw new PlannerFileToolError(
            'planning_limit_reached',
            'Capability Planner document observation budget is exhausted.',
          );
        }
        const documentPaths = await reader.listDocumentPaths(runtime.signal);
        const matcher = globExpression(pattern ?? `**/${CAPABILITY_DOCUMENT_FILE_NAME}`);
        const matches = documentPaths.filter((path) => matchesGlob(path, matcher));
        const start = cursor ?? 0;
        const maxResults = limit ?? DEFAULT_GLOB_LIMIT;
        const paths: string[] = [];
        let usedBytes = 0;
        let stoppedByBudget = false;
        for (const path of matches.slice(start, start + maxResults)) {
          const pathBytes = utf8Bytes(path);
          if (usedBytes + pathBytes > availableBytes) {
            stoppedByBudget = true;
            break;
          }
          paths.push(path);
          usedBytes += pathBytes;
        }
        if (paths.length === 0 && stoppedByBudget) {
          throw new PlannerFileToolError(
            'planning_limit_reached',
            'Capability Planner observation budget cannot fit the next document path.',
          );
        }
        budget.consume(usedBytes);
        const end = start + paths.length;
        const complete = end >= matches.length;
        return formatSuccess(
          CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
          workspace,
          budget,
          {
            pattern: pattern ?? `**/${CAPABILITY_DOCUMENT_FILE_NAME}`,
            paths,
            range: { start, end },
            nextCursor: complete ? null : end,
            complete,
            stoppedBy: stoppedByBudget
              ? 'observation_budget'
              : complete ? null : 'result_limit',
          },
        );
      } catch (error) {
        return formatError(
          CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
          workspace,
          budget,
          error,
        );
      }
    },
    {
      name: CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
      description: 'Enumerate CAPABILITY.md paths in the immutable Workspace when candidate search is not possible or the registry scope must be confirmed. Paths are workspace-relative and ordered; use cursor to continue a truncated result.',
      schema: z.object({
        pattern: z.string().min(1).max(MAX_GLOB_PATTERN_CHARS).optional()
          .describe('Relative glob using *, **, and ?. Defaults to **/CAPABILITY.md.'),
        cursor: z.number().int().nonnegative().optional()
          .describe('Zero-based result cursor from a previous response.'),
        limit: z.number().int().positive().max(MAX_GLOB_LIMIT).optional()
          .describe(`Maximum paths to return; defaults to ${String(DEFAULT_GLOB_LIMIT)}.`),
      }),
    },
  );

  const grepSearch = tool(
    async ({
      query,
      path,
      scope,
      caseSensitive,
      cursor,
      limit,
    }: {
      query: string;
      path?: string;
      scope?: GrepSearchScope;
      caseSensitive?: boolean;
      cursor?: number;
      limit?: number;
    }, runtime: ToolRuntime) => {
      try {
        const availableBytes = documentBudgetAvailable(budget, MAX_GREP_RESULT_BYTES);
        if (availableBytes === 0) {
          throw new PlannerFileToolError(
            'planning_limit_reached',
            'Capability Planner document observation budget is exhausted.',
          );
        }
        const documentPaths = await reader.listDocumentPaths(runtime.signal);
        const selectedPaths = path
          ? [reader.assertDocumentPath(path)]
          : documentPaths;
        const normalizedTerms = grepQueryTerms(query, caseSensitive ?? false);
        const searchScope = scope ?? 'summary';
        const start = cursor ?? 0;
        const maxResults = limit ?? DEFAULT_GREP_LIMIT;
        const matches: Array<{
          path: string;
          lineNumber: number;
          text: string;
          matchedTerms: string[];
          truncated: boolean;
        }> = [];
        let matchIndex = 0;
        let usedBytes = 0;
        let stoppedBy: 'observation_budget' | 'result_limit' | null = null;

        search: for (const selectedPath of selectedPaths) {
          throwIfPlannerFileExplorationAborted(runtime.signal);
          const content = await reader.readDocument(
            selectedPath,
            runtime.signal,
          );
          const lines = grepSearchLines(content, searchScope);
          let firstMatch: {
            lineNumber: number;
            text: string;
            truncated: boolean;
          } | null = null;
          const documentMatchedTerms = new Set<string>();
          for (let index = 0; index < lines.length; index += 1) {
            const rawLine = lines[index]?.replace(/\r$/, '') ?? '';
            const candidate = caseSensitive ? rawLine : rawLine.toLowerCase();
            const matchedTerms = normalizedTerms.filter(
              (term) => candidate.includes(term),
            );
            if (matchedTerms.length === 0) continue;
            matchedTerms.forEach((term) => documentMatchedTerms.add(term));
            if (!firstMatch) {
              const text = truncateUtf8(rawLine, MAX_GREP_LINE_BYTES);
              firstMatch = {
                lineNumber: index + 1,
                text,
                truncated: text !== rawLine,
              };
            }
          }
          if (!firstMatch) continue;
          if (matchIndex < start) {
            matchIndex += 1;
            continue;
          }
          if (matches.length >= maxResults) {
            stoppedBy = 'result_limit';
            break search;
          }
          const item = {
            path: selectedPath,
            lineNumber: firstMatch.lineNumber,
            text: firstMatch.text,
            matchedTerms: [...documentMatchedTerms],
            truncated: firstMatch.truncated,
          };
          const itemBytes = utf8Bytes(JSON.stringify(item));
          if (usedBytes + itemBytes > availableBytes) {
            stoppedBy = 'observation_budget';
            break search;
          }
          matches.push(item);
          usedBytes += itemBytes;
          matchIndex += 1;
        }
        if (matches.length === 0 && stoppedBy === 'observation_budget') {
          throw new PlannerFileToolError(
            'planning_limit_reached',
            'Capability Planner observation budget cannot fit the next grep match.',
          );
        }
        budget.consume(usedBytes);
        const end = start + matches.length;
        return formatSuccess(
          CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
          workspace,
          budget,
          {
            query,
            path: path ?? null,
            scope: searchScope,
            matches,
            range: { start, end },
            nextCursor: stoppedBy ? end : null,
            complete: stoppedBy === null,
            stoppedBy,
          },
        );
      } catch (error) {
        return formatError(
          CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
          workspace,
          budget,
          error,
        );
      }
    },
    {
      name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
      description: 'Find candidate Capabilities in the immutable Workspace from discriminative literal terms derived from the current task and required ability. Terms separated by | use OR semantics. The default summary scope searches routing frontmatter; document scope searches complete documents. Each result represents one matching Capability.',
      schema: z.object({
        query: z.string().min(1).max(MAX_GREP_QUERY_CHARS)
          .describe('A few discriminative literal terms from the current task and required ability, joined by | for OR matching. This is literal text, not a regular expression.'),
        path: z.string().min(1)
          .max(CAPABILITY_PLANNER_DOCUMENT_PATH_MAX_CHARS)
          .optional()
          .describe('Optional exact workspace-relative CAPABILITY.md path.'),
        scope: z.enum(['summary', 'document']).optional()
          .describe('summary searches routing frontmatter and is the default; document searches the complete Capability document.'),
        caseSensitive: z.boolean().optional()
          .describe('Whether matching is case-sensitive; defaults to false.'),
        cursor: z.number().int().nonnegative().optional()
          .describe('Zero-based match cursor from a previous response.'),
        limit: z.number().int().positive().max(MAX_GREP_LIMIT).optional()
          .describe(`Maximum matches to return; defaults to ${String(DEFAULT_GREP_LIMIT)}.`),
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
        const availableBytes = documentBudgetAvailable(budget, MAX_VIEW_RESULT_BYTES);
        if (availableBytes === 0) {
          throw new PlannerFileToolError(
            'planning_limit_reached',
            'Capability Planner document observation budget is exhausted.',
          );
        }
        await reader.listDocumentPaths(runtime.signal);
        const content = await reader.readDocument(path, runtime.signal);
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
        let stoppedBy: 'observation_budget' | 'result_limit' | 'line_too_long' | null = null;

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
                  'Capability Planner observation budget cannot fit the requested line.',
                );
              }
              renderedLines.push(truncated);
              usedBytes = utf8Bytes(truncated);
              truncatedLine = lineNumber;
              stoppedBy = 'line_too_long';
            } else {
              nextStartLine = lineNumber;
              stoppedBy = 'observation_budget';
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
        consumeDocumentObservation(budget, renderedContent);
        const actualEnd = truncatedLine ?? start + renderedLines.length - 1;
        return formatSuccess(
          CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
          workspace,
          budget,
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
        return formatError(
          CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
          workspace,
          budget,
          error,
        );
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
    tools: Object.freeze([globSearch, grepSearch, viewFileChunk]),
    getObservationBudget: () => budget.snapshot(),
    hasReachedObservationLimit: () => budget.hasReachedLimit(),
  });
}
