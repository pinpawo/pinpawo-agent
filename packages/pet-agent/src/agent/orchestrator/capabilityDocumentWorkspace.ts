import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { AgentCapability } from '../../types/capability';
import { CAPABILITY_DOCUMENT_FILE_NAME } from '../../types/capabilityDocument';
import type { CompiledAgentRegistry } from './registry';

export const CAPABILITY_DOCUMENT_WORKSPACE_SCHEMA_VERSION = 1;

export type CapabilityDocumentWorkspaceEntry = {
  readonly capabilityName: string;
  readonly relativePath: string;
  readonly documentDigest: string;
  readonly provenance: 'authored' | 'generated';
};

export type CapabilityDocumentWorkspace = {
  readonly rootPath: string;
  readonly registryDigest: string;
  readonly capabilityNames: readonly string[];
  readonly entries: readonly CapabilityDocumentWorkspaceEntry[];
  readonly reused: boolean;
};

type ResolvedCapabilityDocument = {
  capabilityName: string;
  relativePath: string;
  content: string;
  documentDigest: string;
  provenance: 'authored' | 'generated';
  registryFacts: {
    uses: readonly string[];
    toolkits: ReadonlyArray<{
      name: string;
      description: string;
    }>;
    toolNames: readonly string[];
  };
};

function sha256(content: string) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function quoteYamlString(value: string) {
  return JSON.stringify(value);
}

/**
 * Render an inline runtime Capability as the document the Planner can explore.
 *
 * File-authored Capabilities keep their original source instead. This renderer
 * prevents an inline Capability from becoming invisible to document discovery.
 */
export function renderCapabilityDocument(capability: AgentCapability) {
  const uses = `[${capability.uses.map(quoteYamlString).join(', ')}]`;
  return [
    '---',
    `name: ${quoteYamlString(capability.name)}`,
    `description: ${quoteYamlString(capability.description)}`,
    `uses: ${uses}`,
    'version: 1',
    '---',
    '',
    capability.instructions.content.trim(),
    '',
  ].join('\n');
}

function resolveCapabilityDocument(
  compiled: CompiledAgentRegistry['capabilities'][number],
): ResolvedCapabilityDocument {
  const { capability } = compiled;
  const relativePath = `${capability.name}/${CAPABILITY_DOCUMENT_FILE_NAME}`;
  let content: string;
  let provenance: ResolvedCapabilityDocument['provenance'];

  if (capability.document) {
    content = capability.document.content;
    provenance = 'authored';
  } else {
    content = renderCapabilityDocument(capability);
    provenance = 'generated';
  }

  return {
    capabilityName: capability.name,
    relativePath,
    content,
    documentDigest: sha256(content),
    provenance,
    registryFacts: {
      uses: capability.uses,
      toolkits: compiled.toolkits.map(({ name, description }) => ({
        name,
        description,
      })),
      toolNames: compiled.toolNames,
    },
  };
}

function computeRegistryDigest(documents: readonly ResolvedCapabilityDocument[]) {
  const digestInput = {
    schemaVersion: CAPABILITY_DOCUMENT_WORKSPACE_SCHEMA_VERSION,
    capabilities: documents.map((document) => ({
      name: document.capabilityName,
      documentDigest: document.documentDigest,
      uses: document.registryFacts.uses,
      toolkits: document.registryFacts.toolkits,
      toolNames: document.registryFacts.toolNames,
    })),
  };
  return sha256(JSON.stringify(digestInput));
}

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function chmodReadOnlyBestEffort(path: string, mode: number) {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (
      ['EACCES', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    ) {
      return;
    }
    throw error;
  }
}

async function verifySnapshot(
  rootPath: string,
  documents: readonly ResolvedCapabilityDocument[],
) {
  const rootStats = await lstat(rootPath);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(
      `Capability Document Workspace "${rootPath}" must be a real directory`,
    );
  }
  const expectedCapabilityNames = documents.map(({ capabilityName }) => capabilityName);
  const actualCapabilityNames = (await readdir(rootPath)).sort();
  if (
    actualCapabilityNames.length !== expectedCapabilityNames.length
    || actualCapabilityNames.some(
      (name, index) => name !== expectedCapabilityNames[index],
    )
  ) {
    throw new Error(
      `Capability Document Workspace "${rootPath}" contains unexpected entries`,
    );
  }

  for (const document of documents) {
    const capabilityDir = join(rootPath, document.capabilityName);
    const capabilityDirStats = await lstat(capabilityDir);
    if (
      !capabilityDirStats.isDirectory()
      || capabilityDirStats.isSymbolicLink()
    ) {
      throw new Error(
        `Capability Document Workspace "${rootPath}" contains an invalid directory for "${document.capabilityName}"`,
      );
    }
    const capabilityEntries = await readdir(capabilityDir);
    if (
      capabilityEntries.length !== 1
      || capabilityEntries[0] !== CAPABILITY_DOCUMENT_FILE_NAME
    ) {
      throw new Error(
        `Capability Document Workspace "${rootPath}" contains unexpected files for "${document.capabilityName}"`,
      );
    }
    const copiedPath = join(rootPath, document.relativePath);
    const copiedStats = await lstat(copiedPath);
    if (!copiedStats.isFile() || copiedStats.isSymbolicLink()) {
      throw new Error(
        `Capability Document Workspace "${rootPath}" contains an invalid document for "${document.capabilityName}"`,
      );
    }
    const copied = await readFile(copiedPath, 'utf8');
    if (sha256(copied) !== document.documentDigest) {
      throw new Error(
        `Capability Document Workspace "${rootPath}" failed verification for "${document.capabilityName}"`,
      );
    }
  }
}

function freezeWorkspace(params: {
  rootPath: string;
  registryDigest: string;
  documents: readonly ResolvedCapabilityDocument[];
  reused: boolean;
}): CapabilityDocumentWorkspace {
  const entries = params.documents.map((document) => Object.freeze({
    capabilityName: document.capabilityName,
    relativePath: document.relativePath,
    documentDigest: document.documentDigest,
    provenance: document.provenance,
  }));
  return Object.freeze({
    rootPath: params.rootPath,
    registryDigest: params.registryDigest,
    capabilityNames: Object.freeze(entries.map(({ capabilityName }) => capabilityName)),
    entries: Object.freeze(entries),
    reused: params.reused,
  });
}

/**
 * Materialize one immutable, digest-addressed document view of the compiled
 * and host-allowed Capability registry.
 */
export async function materializeCapabilityDocumentWorkspace(params: {
  registry: CompiledAgentRegistry;
  cacheRoot: string;
  allowedCapabilityNames?: readonly string[];
}): Promise<CapabilityDocumentWorkspace> {
  if (!isAbsolute(params.cacheRoot)) {
    throw new Error('Capability Document Workspace cacheRoot must be absolute');
  }
  if (
    params.allowedCapabilityNames?.some(
      (name) => typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(name),
    )
  ) {
    throw new Error('allowedCapabilityNames must contain valid Capability names');
  }
  const allowedNames = params.allowedCapabilityNames
    ? new Set(params.allowedCapabilityNames)
    : null;
  if (
    allowedNames
    && allowedNames.size !== params.allowedCapabilityNames?.length
  ) {
    throw new Error('allowedCapabilityNames must not contain duplicates');
  }

  const selected = params.registry.capabilities
    .filter(({ capability }) => !allowedNames || allowedNames.has(capability.name))
    .sort((left, right) =>
      left.capability.name < right.capability.name
        ? -1
        : left.capability.name > right.capability.name ? 1 : 0);
  const documents = selected.map(resolveCapabilityDocument);
  const registryDigest = computeRegistryDigest(documents);
  const cacheRoot = params.cacheRoot;
  const rootPath = join(cacheRoot, registryDigest);
  await mkdir(cacheRoot, { recursive: true });

  if (await isDirectory(rootPath)) {
    await verifySnapshot(rootPath, documents);
    return freezeWorkspace({
      rootPath,
      registryDigest,
      documents,
      reused: true,
    });
  }

  const temporaryRoot = await mkdtemp(join(cacheRoot, `.building-${registryDigest}-`));
  let published = false;
  try {
    for (const document of documents) {
      const capabilityDir = join(temporaryRoot, document.capabilityName);
      await mkdir(capabilityDir);
      await writeFile(
        join(temporaryRoot, document.relativePath),
        document.content,
        { encoding: 'utf8', mode: 0o444, flag: 'wx' },
      );
    }

    try {
      await rename(temporaryRoot, rootPath);
      published = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        !['EEXIST', 'ENOTEMPTY'].includes(code ?? '')
        || !(await isDirectory(rootPath))
      ) {
        throw error;
      }
    }

    await verifySnapshot(rootPath, documents);
    if (published) {
      await Promise.all(
        documents.map((document) =>
          chmodReadOnlyBestEffort(
            join(rootPath, document.capabilityName),
            0o555,
          )),
      );
      await chmodReadOnlyBestEffort(rootPath, 0o555);
    }
    return freezeWorkspace({
      rootPath,
      registryDigest,
      documents,
      reused: !published,
    });
  } finally {
    if (!published) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
