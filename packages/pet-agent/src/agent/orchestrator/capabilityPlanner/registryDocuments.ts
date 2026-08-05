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
  /** Complete verified CAPABILITY.md content; matches are never line excerpts. */
  readonly content: string;
  readonly matchedTerms: readonly string[];
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
    signal?: AbortSignal;
  }): Promise<CapabilityRegistrySearchResult>;
}

function utf8Bytes(content: string) {
  return Buffer.byteLength(content, 'utf8');
}

function matchedTerms(content: string, terms: readonly string[]) {
  const normalizedContent = content.toLowerCase();
  return terms.filter((term) => normalizedContent.includes(term));
}

function appendMatch(params: {
  matches: CapabilityRegistrySearchMatch[];
  path: string;
  content: string;
  terms: readonly string[];
  maxResults: number;
  maxResultBytes: number;
  usedBytes: number;
}) {
  if (params.matches.length >= params.maxResults) {
    return { usedBytes: params.usedBytes, stoppedBy: 'result_limit' as const };
  }
  const item = {
    path: params.path,
    content: params.content,
    matchedTerms: matchedTerms(params.content, params.terms),
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
  signal?: AbortSignal;
}): Promise<{
  paths: readonly string[];
  complete: boolean;
  stoppedBy: 'result_limit' | null;
}> {
  if (params.signal?.aborted) throw createAbortError();
  if (params.documentPaths.length === 0) {
    return { paths: [], complete: true, stoppedBy: null };
  }

  const args = [
    '-l',
    '-i',
    '-F',
    ...params.terms.flatMap((term) => ['-e', term]),
    '--',
    ...params.documentPaths,
  ];
  const paths: string[] = [];
  const allowedPaths = new Set(params.documentPaths);
  let stoppedBy: 'result_limit' | null = null;
  let buffer = '';
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
    const consumeLine = (record: string) => {
      if (!record || stoppedBy) return;
      const path = record.replace(/\r$/, '');
      if (!allowedPaths.has(path)) return;
      if (paths.length >= params.maxResults) {
        stoppedBy = 'result_limit';
        stop();
        return;
      }
      paths.push(path);
    };
    const consumeChunk = (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
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
      if (buffer) consumeLine(buffer);
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
    paths,
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
    const candidates = await runFilesystemGrep({
      rootPath: this.#workspace.rootPath,
      documentPaths,
      terms: params.terms,
      maxResults: params.maxResults,
      signal: params.signal,
    });
    const matches: CapabilityRegistrySearchMatch[] = [];
    let usedBytes = 0;
    let stoppedBy: CapabilityRegistrySearchResult['stoppedBy'] = null;
    for (const path of candidates.paths) {
      const content = await this.#reader.readDocument(path, params.signal);
      const appended = appendMatch({
        matches,
        path,
        content,
        terms: params.terms,
        maxResults: params.maxResults,
        maxResultBytes: params.maxResultBytes,
        usedBytes,
      });
      usedBytes = appended.usedBytes;
      stoppedBy = appended.stoppedBy;
      if (stoppedBy) break;
    }
    return {
      matches,
      complete: candidates.complete && stoppedBy === null,
      stoppedBy: stoppedBy ?? candidates.stoppedBy,
    };
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
      if (matchedTerms(content, params.terms).length === 0) continue;
      const appended = appendMatch({
        matches,
        path,
        content,
        terms: params.terms,
        maxResults: params.maxResults,
        maxResultBytes: params.maxResultBytes,
        usedBytes,
      });
      usedBytes = appended.usedBytes;
      stoppedBy = appended.stoppedBy;
      if (stoppedBy) break search;
    }
    return { matches, complete: stoppedBy === null, stoppedBy };
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
