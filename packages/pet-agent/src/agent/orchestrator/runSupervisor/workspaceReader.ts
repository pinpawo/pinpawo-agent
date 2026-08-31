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
import { CAPABILITY_DOCUMENT_FILE_NAME } from '../../../types/capabilityDocument';
import type {
  CapabilityDocumentWorkspace,
  CapabilityDocumentWorkspaceEntry,
} from './documentWorkspace';

export const RUN_SUPERVISOR_DOCUMENT_PATH_MAX_CHARS = 512;

export type SupervisorFileToolErrorCode =
  | 'aborted'
  | 'document_not_found'
  | 'document_tampered'
  | 'invalid_path'
  | 'invalid_query'
  | 'invalid_range'
  | 'supervisor_discovery_limit_reached'
  | 'workspace_invalid'
  | 'workspace_unavailable';

export class SupervisorFileToolError extends Error {
  readonly code: SupervisorFileToolErrorCode;

  constructor(code: SupervisorFileToolErrorCode, message: string) {
    super(message);
    this.name = 'SupervisorFileToolError';
    this.code = code;
  }
}

export function throwIfSupervisorFileExplorationAborted(
  signal: AbortSignal | undefined,
) {
  if (signal?.aborted) {
    throw new SupervisorFileToolError(
      'aborted',
      'Run Supervisor file exploration was aborted.',
    );
  }
}

export function stableSupervisorFileToolError(error: unknown) {
  if (error instanceof SupervisorFileToolError) return error;
  return new SupervisorFileToolError(
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

export class RunSupervisorWorkspaceReader {
  readonly workspace: CapabilityDocumentWorkspace;
  readonly #entries: ReadonlyMap<string, CapabilityDocumentWorkspaceEntry>;

  constructor(workspace: CapabilityDocumentWorkspace) {
    this.workspace = workspace;
    this.#entries = buildEntryMap(workspace);
  }

  assertDocumentPath(path: string) {
    if (
      !path
      || path.length > RUN_SUPERVISOR_DOCUMENT_PATH_MAX_CHARS
      || isAbsolute(path)
      || path.includes('\\')
      || path.includes('\0')
      || posix.normalize(path) !== path
      || path === '..'
      || path.startsWith('../')
    ) {
      throw new SupervisorFileToolError(
        'invalid_path',
        'path must be a normalized workspace-relative CAPABILITY.md path',
      );
    }
    const entry = this.#entries.get(path);
    if (!entry) {
      throw new SupervisorFileToolError(
        'document_not_found',
        `Capability document "${path}" is not part of this registry generation.`,
      );
    }
    return entry.relativePath;
  }

  async listDocumentPaths(signal?: AbortSignal) {
    throwIfSupervisorFileExplorationAborted(signal);
    const rootStats = await lstat(this.workspace.rootPath);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new SupervisorFileToolError(
        'workspace_invalid',
        'Capability Document Workspace root is not a real directory.',
      );
    }

    const expectedNames = [...this.workspace.capabilityNames].sort();
    const actualNames = (await readdir(this.workspace.rootPath)).sort();
    if (!sameOrderedValues(actualNames, expectedNames)) {
      throw new SupervisorFileToolError(
        'workspace_invalid',
        'Capability Document Workspace contains unexpected entries.',
      );
    }

    const documentPaths: string[] = [];
    for (const capabilityName of expectedNames) {
      throwIfSupervisorFileExplorationAborted(signal);
      const capabilityDir = join(this.workspace.rootPath, capabilityName);
      const capabilityStats = await lstat(capabilityDir);
      if (!capabilityStats.isDirectory() || capabilityStats.isSymbolicLink()) {
        throw new SupervisorFileToolError(
          'workspace_invalid',
          `Capability document directory "${capabilityName}" is invalid.`,
        );
      }
      const childNames = await readdir(capabilityDir);
      if (
        childNames.length !== 1
        || childNames[0] !== CAPABILITY_DOCUMENT_FILE_NAME
      ) {
        throw new SupervisorFileToolError(
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
        throw new SupervisorFileToolError(
          'workspace_invalid',
          `Capability document "${relativePath}" is invalid.`,
        );
      }
      documentPaths.push(relativePath);
    }
    return documentPaths;
  }

  async readDocument(path: string, signal?: AbortSignal) {
    throwIfSupervisorFileExplorationAborted(signal);
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
      throw new SupervisorFileToolError(
        'invalid_path',
        `Capability document "${relativePath}" resolves outside the workspace.`,
      );
    }
    const content = await readFile(fileRealPath, 'utf8');
    if (sha256(content) !== entry.documentDigest) {
      throw new SupervisorFileToolError(
        'document_tampered',
        `Capability document "${relativePath}" no longer matches this registry generation.`,
      );
    }
    return content;
  }
}
