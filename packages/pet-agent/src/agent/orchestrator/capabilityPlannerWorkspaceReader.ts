import { createHash } from 'node:crypto';
import {
  lstat,
  readdir,
  readFile,
  realpath,
} from 'node:fs/promises';
import {
  isAbsolute,
  join,
  posix,
  relative,
  sep,
} from 'node:path';
import { CAPABILITY_DOCUMENT_FILE_NAME } from '../../types/capabilityDocument';
import type {
  CapabilityDocumentWorkspace,
  CapabilityDocumentWorkspaceEntry,
} from './capabilityDocumentWorkspace';

export const CAPABILITY_PLANNER_DOCUMENT_PATH_MAX_CHARS = 512;

export type PlannerFileToolErrorCode =
  | 'aborted'
  | 'document_not_found'
  | 'document_tampered'
  | 'invalid_path'
  | 'invalid_query'
  | 'invalid_range'
  | 'planning_limit_reached'
  | 'workspace_invalid'
  | 'workspace_unavailable';

export class PlannerFileToolError extends Error {
  readonly code: PlannerFileToolErrorCode;

  constructor(code: PlannerFileToolErrorCode, message: string) {
    super(message);
    this.name = 'PlannerFileToolError';
    this.code = code;
  }
}

export function throwIfPlannerFileExplorationAborted(
  signal: AbortSignal | undefined,
) {
  if (signal?.aborted) {
    throw new PlannerFileToolError(
      'aborted',
      'Capability Planner file exploration was aborted.',
    );
  }
}

export function stablePlannerFileToolError(error: unknown) {
  if (error instanceof PlannerFileToolError) return error;
  return new PlannerFileToolError(
    'workspace_unavailable',
    'Capability Document Workspace could not be read.',
  );
}

function sha256(content: string) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function sameOrderedValues(left: readonly string[], right: readonly string[]) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function buildEntryMap(workspace: CapabilityDocumentWorkspace) {
  if (!isAbsolute(workspace.rootPath)) {
    throw new Error('Capability Document Workspace rootPath must be absolute');
  }
  if (
    typeof workspace.registryDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(workspace.registryDigest)
  ) {
    throw new Error('Capability Document Workspace registryDigest must be SHA-256');
  }

  const entries = new Map<string, CapabilityDocumentWorkspaceEntry>();
  for (const entry of workspace.entries) {
    const expectedPath = `${entry.capabilityName}/${CAPABILITY_DOCUMENT_FILE_NAME}`;
    if (
      entry.relativePath !== expectedPath
      || entries.has(entry.relativePath)
      || !workspace.capabilityNames.includes(entry.capabilityName)
      || !/^[a-f0-9]{64}$/.test(entry.documentDigest)
    ) {
      throw new Error('Capability Document Workspace contains an invalid entry');
    }
    entries.set(entry.relativePath, entry);
  }
  if (
    entries.size !== workspace.capabilityNames.length
    || new Set(workspace.capabilityNames).size !== workspace.capabilityNames.length
  ) {
    throw new Error('Capability Document Workspace entry names must be unique and complete');
  }
  return entries;
}

export class CapabilityPlannerWorkspaceReader {
  readonly workspace: CapabilityDocumentWorkspace;
  readonly #entries: ReadonlyMap<string, CapabilityDocumentWorkspaceEntry>;

  constructor(workspace: CapabilityDocumentWorkspace) {
    this.workspace = workspace;
    this.#entries = buildEntryMap(workspace);
  }

  assertDocumentPath(path: string) {
    if (
      !path
      || path.length > CAPABILITY_PLANNER_DOCUMENT_PATH_MAX_CHARS
      || isAbsolute(path)
      || path.includes('\\')
      || path.includes('\0')
      || posix.normalize(path) !== path
      || path === '..'
      || path.startsWith('../')
    ) {
      throw new PlannerFileToolError(
        'invalid_path',
        'path must be a normalized workspace-relative CAPABILITY.md path',
      );
    }
    const entry = this.#entries.get(path);
    if (!entry) {
      throw new PlannerFileToolError(
        'document_not_found',
        `Capability document "${path}" is not part of this registry generation.`,
      );
    }
    return entry.relativePath;
  }

  async listDocumentPaths(signal?: AbortSignal) {
    throwIfPlannerFileExplorationAborted(signal);
    const rootStats = await lstat(this.workspace.rootPath);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new PlannerFileToolError(
        'workspace_invalid',
        'Capability Document Workspace root is not a real directory.',
      );
    }

    const expectedNames = [...this.workspace.capabilityNames].sort();
    const actualNames = (await readdir(this.workspace.rootPath)).sort();
    if (!sameOrderedValues(actualNames, expectedNames)) {
      throw new PlannerFileToolError(
        'workspace_invalid',
        'Capability Document Workspace contains unexpected entries.',
      );
    }

    const documentPaths: string[] = [];
    for (const capabilityName of expectedNames) {
      throwIfPlannerFileExplorationAborted(signal);
      const capabilityDir = join(this.workspace.rootPath, capabilityName);
      const capabilityStats = await lstat(capabilityDir);
      if (!capabilityStats.isDirectory() || capabilityStats.isSymbolicLink()) {
        throw new PlannerFileToolError(
          'workspace_invalid',
          `Capability document directory "${capabilityName}" is invalid.`,
        );
      }
      const childNames = await readdir(capabilityDir);
      if (
        childNames.length !== 1
        || childNames[0] !== CAPABILITY_DOCUMENT_FILE_NAME
      ) {
        throw new PlannerFileToolError(
          'workspace_invalid',
          `Capability document directory "${capabilityName}" contains unexpected entries.`,
        );
      }
      const relativePath = `${capabilityName}/${CAPABILITY_DOCUMENT_FILE_NAME}`;
      const documentStats = await lstat(
        join(this.workspace.rootPath, capabilityName, childNames[0]),
      );
      if (
        !documentStats.isFile()
        || documentStats.isSymbolicLink()
        || !this.#entries.has(relativePath)
      ) {
        throw new PlannerFileToolError(
          'workspace_invalid',
          `Capability document "${relativePath}" is invalid.`,
        );
      }
      documentPaths.push(relativePath);
    }
    return documentPaths;
  }

  async readDocument(path: string, signal?: AbortSignal) {
    throwIfPlannerFileExplorationAborted(signal);
    const relativePath = this.assertDocumentPath(path);
    const entry = this.#entries.get(relativePath)!;
    const rootRealPath = await realpath(this.workspace.rootPath);
    const filePath = join(this.workspace.rootPath, ...relativePath.split('/'));
    const fileRealPath = await realpath(filePath);
    const relativeRealPath = relative(rootRealPath, fileRealPath);
    if (
      !relativeRealPath
      || relativeRealPath === '..'
      || relativeRealPath.startsWith(`..${sep}`)
      || isAbsolute(relativeRealPath)
    ) {
      throw new PlannerFileToolError(
        'invalid_path',
        `Capability document "${relativePath}" resolves outside the workspace.`,
      );
    }
    const content = await readFile(fileRealPath, 'utf8');
    if (sha256(content) !== entry.documentDigest) {
      throw new PlannerFileToolError(
        'document_tampered',
        `Capability document "${relativePath}" no longer matches this registry generation.`,
      );
    }
    return content;
  }
}
