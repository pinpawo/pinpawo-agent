import { spawn } from 'node:child_process';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import {
  CapabilityPlannerWorkspaceReader,
  PlannerFileToolError,
  throwIfPlannerFileExplorationAborted,
} from './workspaceReader';

export const CAPABILITY_REGISTRY_BACKEND = {
  FILESYSTEM: 'filesystem',
  MEMORY: 'memory',
} as const;

export type CapabilityRegistryBackend =
  typeof CAPABILITY_REGISTRY_BACKEND[keyof typeof CAPABILITY_REGISTRY_BACKEND];

export type CapabilityRegistrySearchMatch = {
  readonly path: string;
  readonly lineNumber: number;
  readonly text: string;
  readonly matchedTerms: readonly string[];
  readonly truncated: boolean;
};

export type CapabilityRegistrySearchResult = {
  readonly matches: readonly CapabilityRegistrySearchMatch[];
  readonly complete: boolean;
  readonly stoppedBy: 'result_size' | 'result_limit' | null;
};

export interface CapabilityRegistryDocuments {
  search(params: {
    terms: readonly string[];
    maxResults: number;
    maxResultBytes: number;
    maxLineBytes: number;
    signal?: AbortSignal;
  }): Promise<CapabilityRegistrySearchResult>;
  readDocument(path: string, signal?: AbortSignal): Promise<string>;
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

function matchedTerms(line: string, terms: readonly string[]) {
  const normalizedLine = line.toLowerCase();
  return terms.filter((term) => normalizedLine.includes(term));
}

function appendMatch(params: {
  matches: CapabilityRegistrySearchMatch[];
  path: string;
  lineNumber: number;
  line: string;
  terms: readonly string[];
  maxResults: number;
  maxResultBytes: number;
  maxLineBytes: number;
  usedBytes: number;
  sourceTruncated?: boolean;
}) {
  if (params.matches.length >= params.maxResults) {
    return { usedBytes: params.usedBytes, stoppedBy: 'result_limit' as const };
  }
  const text = truncateUtf8(params.line, params.maxLineBytes);
  const item = {
    path: params.path,
    lineNumber: params.lineNumber,
    text,
    matchedTerms: matchedTerms(params.line, params.terms),
    truncated: params.sourceTruncated === true || text !== params.line,
  } satisfies CapabilityRegistrySearchMatch;
  const itemBytes = utf8Bytes(JSON.stringify(item));
  if (params.usedBytes + itemBytes > params.maxResultBytes) {
    return { usedBytes: params.usedBytes, stoppedBy: 'result_size' as const };
  }
  params.matches.push(item);
  return { usedBytes: params.usedBytes + itemBytes, stoppedBy: null };
}

function createAbortError() {
  return new PlannerFileToolError(
    'aborted',
    'Capability registry search was aborted.',
  );
}

async function runFilesystemGrep(params: {
  rootPath: string;
  documentPaths: readonly string[];
  terms: readonly string[];
  maxResults: number;
  maxResultBytes: number;
  maxLineBytes: number;
  signal?: AbortSignal;
}): Promise<CapabilityRegistrySearchResult> {
  if (params.signal?.aborted) throw createAbortError();
  if (params.documentPaths.length === 0) {
    return { matches: [], complete: true, stoppedBy: null };
  }

  const args = [
    '-H',
    '-n',
    '-i',
    '-F',
    '-m',
    '1',
    ...params.terms.flatMap((term) => ['-e', term]),
    '--',
    ...params.documentPaths,
  ];
  const matches: CapabilityRegistrySearchMatch[] = [];
  let usedBytes = 0;
  let stoppedBy: CapabilityRegistrySearchResult['stoppedBy'] = null;
  let buffer = '';
  let recordTruncated = false;
  let stderr = '';

  await new Promise<void>((resolve, reject) => {
    const child = spawn('grep', args, {
      cwd: params.rootPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stopped = false;
    let aborted = false;
    let spawnError: Error | null = null;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill('SIGTERM');
    };
    const consumeLine = (record: string, sourceTruncated = false) => {
      if (!record || stoppedBy) return;
      const parsed = /^(.+?):(\d+):(.*)$/.exec(record);
      if (!parsed) return;
      const path = parsed[1] ?? '';
      const lineNumber = Number(parsed[2]);
      const line = parsed[3] ?? '';
      const appended = appendMatch({
        matches,
        path,
        lineNumber,
        line,
        terms: params.terms,
        maxResults: params.maxResults,
        maxResultBytes: params.maxResultBytes,
        maxLineBytes: params.maxLineBytes,
        usedBytes,
        sourceTruncated,
      });
      usedBytes = appended.usedBytes;
      stoppedBy = appended.stoppedBy;
      if (stoppedBy) stop();
    };
    const consumeChunk = (chunk: string) => {
      let remaining = chunk;
      while (remaining) {
        const newline = remaining.indexOf('\n');
        const segment = newline >= 0 ? remaining.slice(0, newline) : remaining;
        if (!recordTruncated) {
          const candidate = buffer + segment;
          const bounded = truncateUtf8(candidate, params.maxLineBytes + 1_024);
          buffer = bounded;
          recordTruncated = bounded !== candidate;
        }
        if (newline < 0) break;
        consumeLine(buffer.replace(/\r$/, ''), recordTruncated);
        buffer = '';
        recordTruncated = false;
        remaining = remaining.slice(newline + 1);
      }
    };
    const abort = () => {
      aborted = true;
      stop();
    };
    params.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', consumeChunk);
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 10_000) {
        stderr += chunk.slice(0, 10_000 - stderr.length);
      }
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code) => {
      params.signal?.removeEventListener('abort', abort);
      if (buffer) consumeLine(buffer.replace(/\r$/, ''), recordTruncated);
      if (aborted) {
        reject(createAbortError());
        return;
      }
      if (spawnError) {
        const codeValue = (spawnError as NodeJS.ErrnoException).code;
        reject(new PlannerFileToolError(
          'workspace_unavailable',
          codeValue === 'ENOENT'
            ? 'Capability registry filesystem backend requires the system grep executable.'
            : 'Capability registry filesystem search could not be started.',
        ));
        return;
      }
      if (!stopped && code !== 0 && code !== 1) {
        reject(new PlannerFileToolError(
          'workspace_unavailable',
          stderr.trim() || `Capability registry grep failed with exit code ${code ?? '?'}.`,
        ));
        return;
      }
      resolve();
    });
  });

  return {
    matches,
    complete: stoppedBy === null,
    stoppedBy,
  };
}

class FileSystemCapabilityRegistryDocuments implements CapabilityRegistryDocuments {
  readonly #workspace: CapabilityDocumentWorkspace;
  readonly #reader: CapabilityPlannerWorkspaceReader;

  constructor(workspace: CapabilityDocumentWorkspace) {
    this.#workspace = workspace;
    this.#reader = new CapabilityPlannerWorkspaceReader(workspace);
  }

  async search(params: Parameters<CapabilityRegistryDocuments['search']>[0]) {
    const documentPaths = await this.#reader.listDocumentPaths(params.signal);
    const result = await runFilesystemGrep({
      rootPath: this.#workspace.rootPath,
      documentPaths,
      ...params,
    });
    for (const { path } of result.matches) {
      await this.#reader.readDocument(path, params.signal);
    }
    return result;
  }

  async readDocument(path: string, signal?: AbortSignal) {
    await this.#reader.listDocumentPaths(signal);
    return this.#reader.readDocument(path, signal);
  }
}

class InMemoryCapabilityRegistryDocuments implements CapabilityRegistryDocuments {
  readonly #reader: CapabilityPlannerWorkspaceReader;
  #documents: Promise<ReadonlyMap<string, string>> | null = null;

  constructor(workspace: CapabilityDocumentWorkspace) {
    this.#reader = new CapabilityPlannerWorkspaceReader(workspace);
  }

  #load(signal?: AbortSignal) {
    this.#documents ??= (async () => {
      const paths = await this.#reader.listDocumentPaths(signal);
      const entries: Array<readonly [string, string]> = [];
      for (const path of paths) {
        entries.push([path, await this.#reader.readDocument(path, signal)]);
      }
      return new Map(entries);
    })();
    return this.#documents;
  }

  async search(params: Parameters<CapabilityRegistryDocuments['search']>[0]) {
    const documents = await this.#load(params.signal);
    const matches: CapabilityRegistrySearchMatch[] = [];
    let usedBytes = 0;
    let stoppedBy: CapabilityRegistrySearchResult['stoppedBy'] = null;

    search: for (const [path, content] of documents) {
      throwIfPlannerFileExplorationAborted(params.signal);
      const lines = content.split('\n').map((line) => line.replace(/\r$/, ''));
      for (const [index, line] of lines.entries()) {
        if (matchedTerms(line, params.terms).length === 0) continue;
        const appended = appendMatch({
          matches,
          path,
          lineNumber: index + 1,
          line,
          terms: params.terms,
          maxResults: params.maxResults,
          maxResultBytes: params.maxResultBytes,
          maxLineBytes: params.maxLineBytes,
          usedBytes,
        });
        usedBytes = appended.usedBytes;
        stoppedBy = appended.stoppedBy;
        if (stoppedBy) break search;
        break;
      }
    }
    return { matches, complete: stoppedBy === null, stoppedBy };
  }

  async readDocument(path: string, signal?: AbortSignal) {
    throwIfPlannerFileExplorationAborted(signal);
    const relativePath = this.#reader.assertDocumentPath(path);
    const content = (await this.#load(signal)).get(relativePath);
    if (content === undefined) {
      throw new PlannerFileToolError(
        'document_not_found',
        `Capability document "${relativePath}" is not available in memory.`,
      );
    }
    return content;
  }
}

export function createCapabilityRegistryDocuments(params: {
  workspace: CapabilityDocumentWorkspace;
  backend: CapabilityRegistryBackend;
}): CapabilityRegistryDocuments {
  if (params.backend === CAPABILITY_REGISTRY_BACKEND.FILESYSTEM) {
    return new FileSystemCapabilityRegistryDocuments(params.workspace);
  }
  if (params.backend === CAPABILITY_REGISTRY_BACKEND.MEMORY) {
    return new InMemoryCapabilityRegistryDocuments(params.workspace);
  }
  throw new Error(`Unsupported Capability registry backend: ${String(params.backend)}`);
}
