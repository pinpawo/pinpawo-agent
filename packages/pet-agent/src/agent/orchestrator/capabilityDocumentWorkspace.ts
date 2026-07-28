import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentCapability } from '../../types/capability';
import { CAPABILITY_DOCUMENT_FILE_NAME } from '../../types/capabilityDocument';
import type { CompiledAgentRegistry } from './registry';

export const CAPABILITY_DOCUMENT_WORKSPACE_SCHEMA_VERSION = 1;
// One repair is enough for a derived digest snapshot. Extra attempts only
// absorb cross-process publish/quarantine races; they must not form an
// unbounded recovery loop under continuous external mutation.
const MAX_WORKSPACE_MATERIALIZATION_ATTEMPTS = 4;
const MAX_WORKSPACE_REPAIRS = 1;
const REPAIR_LOCK_POLL_INTERVAL_MS = 10;
const REPAIR_LOCK_WAIT_TIMEOUT_MS = 5_000;

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

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

type RepairLockOwner = {
  pid: number;
  token: string;
};

function parseRepairLockOwner(value: string): RepairLockOwner | null {
  try {
    const owner = JSON.parse(value) as Partial<RepairLockOwner>;
    if (
      !Number.isSafeInteger(owner.pid)
      || (owner.pid ?? 0) <= 0
      || typeof owner.token !== 'string'
      || owner.token.length === 0
    ) {
      return null;
    }
    return {
      pid: owner.pid!,
      token: owner.token,
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function isRepairLockActive(lockPath: string) {
  try {
    const lockStats = await lstat(lockPath);
    if (!lockStats.isDirectory() || lockStats.isSymbolicLink()) {
      return false;
    }
    const owner = parseRepairLockOwner(
      await readFile(join(lockPath, 'owner.json'), 'utf8'),
    );
    return owner ? isProcessAlive(owner.pid) : false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function acquireRepairLock(params: {
  cacheRoot: string;
  registryDigest: string;
}) {
  const lockPath = join(
    params.cacheRoot,
    `.repair-${params.registryDigest}.lock`,
  );
  const owner: RepairLockOwner = {
    pid: process.pid,
    token: randomUUID(),
  };
  const pendingLockPath = join(
    params.cacheRoot,
    `.pending-repair-${params.registryDigest}-${owner.token}`,
  );
  const deadline = Date.now() + REPAIR_LOCK_WAIT_TIMEOUT_MS;
  // Publish a fully initialized lock directory atomically. Contenders never
  // observe a partially written owner record and mistake it for a dead owner.
  await mkdir(pendingLockPath);
  await writeFile(
    join(pendingLockPath, 'owner.json'),
    JSON.stringify(owner),
    { encoding: 'utf8', flag: 'wx' },
  );
  let acquired = false;

  try {
    while (true) {
      try {
        await rename(pendingLockPath, lockPath);
        acquired = true;
        return async () => {
          try {
            const currentOwner = parseRepairLockOwner(
              await readFile(join(lockPath, 'owner.json'), 'utf8'),
            );
            if (currentOwner?.token === owner.token) {
              await rm(lockPath, { recursive: true, force: true });
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw error;
            }
          }
        };
      } catch (error) {
        if (
          !['EEXIST', 'ENOTEMPTY'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        ) {
          throw error;
        }
      }

      if (!(await isRepairLockActive(lockPath))) {
        const abandonedPath = join(
          params.cacheRoot,
          `.abandoned-repair-${params.registryDigest}-${randomUUID()}`,
        );
        try {
          await rename(lockPath, abandonedPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
        // Abandoned lock generations are tiny and follow the same deferred-GC
        // policy as invalid workspace generations.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for Capability Document Workspace repair lock "${lockPath}"`,
        );
      }
      await delay(REPAIR_LOCK_POLL_INTERVAL_MS);
    }
  } finally {
    if (!acquired) {
      await rm(pendingLockPath, { recursive: true, force: true });
    }
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

async function quarantineInvalidSnapshot(params: {
  rootPath: string;
  cacheRoot: string;
  registryDigest: string;
  documents: readonly ResolvedCapabilityDocument[];
}) {
  const releaseLock = await acquireRepairLock(params);
  try {
    if (!(await pathExists(params.rootPath))) {
      return false;
    }
    try {
      await verifySnapshot(params.rootPath, params.documents);
      return false;
    } catch (verificationError) {
      const quarantinePath = join(
        params.cacheRoot,
        `.invalid-${params.registryDigest}-${randomUUID()}`,
      );
      try {
        await rename(params.rootPath, quarantinePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return false;
        }
        throw error;
      }
      console.warn('[pet-agent] repairing invalid Capability Document Workspace:', {
        code: 'capability_workspace_snapshot_quarantined',
        rootPath: params.rootPath,
        quarantinePath,
        registryDigest: params.registryDigest,
        error: verificationError instanceof Error
          ? verificationError.message
          : String(verificationError),
      });
      // Quarantine cleanup is deliberately outside materialization. The
      // canonical path is rebuilt first; a later GC policy may remove invalid
      // generations without delaying the Capability Planner.
      return true;
    }
  } finally {
    await releaseLock();
  }
}

async function publishSnapshot(params: {
  cacheRoot: string;
  rootPath: string;
  registryDigest: string;
  documents: readonly ResolvedCapabilityDocument[];
}): Promise<'published' | 'lost_race'> {
  const temporaryRoot = await mkdtemp(
    join(params.cacheRoot, `.building-${params.registryDigest}-`),
  );
  let published = false;
  try {
    for (const document of params.documents) {
      const capabilityDir = join(temporaryRoot, document.capabilityName);
      await mkdir(capabilityDir, { mode: 0o755 });
      await writeFile(
        join(temporaryRoot, document.relativePath),
        document.content,
        { encoding: 'utf8', mode: 0o444, flag: 'wx' },
      );
    }
    await verifySnapshot(temporaryRoot, params.documents);

    try {
      await rename(temporaryRoot, params.rootPath);
      published = true;
      return 'published' as const;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        !['EEXIST', 'ENOTEMPTY'].includes(code ?? '')
        || !(await pathExists(params.rootPath))
      ) {
        throw error;
      }
      return 'lost_race' as const;
    }
  } finally {
    if (!published) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
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

  let repairs = 0;
  let lastVerificationError: unknown = null;
  const recoverInvalidSnapshot = async (error: unknown) => {
    lastVerificationError = error;
    if (repairs >= MAX_WORKSPACE_REPAIRS) {
      return false;
    }
    const quarantined = await quarantineInvalidSnapshot({
      rootPath,
      cacheRoot,
      registryDigest,
      documents,
    });
    if (quarantined) {
      repairs += 1;
    }
    return true;
  };
  for (
    let attempt = 0;
    attempt < MAX_WORKSPACE_MATERIALIZATION_ATTEMPTS;
    attempt += 1
  ) {
    if (await pathExists(rootPath)) {
      try {
        await verifySnapshot(rootPath, documents);
        return freezeWorkspace({
          rootPath,
          registryDigest,
          documents,
          reused: true,
        });
      } catch (error) {
        if (!(await recoverInvalidSnapshot(error))) {
          break;
        }
        continue;
      }
    }

    const publication = await publishSnapshot({
      cacheRoot,
      rootPath,
      registryDigest,
      documents,
    });
    if (publication === 'lost_race') {
      continue;
    }

    try {
      await verifySnapshot(rootPath, documents);
      return freezeWorkspace({
        rootPath,
        registryDigest,
        documents,
        reused: false,
      });
    } catch (error) {
      if (!(await recoverInvalidSnapshot(error))) {
        break;
      }
    }
  }

  throw new Error(
    `Capability Document Workspace "${rootPath}" could not be verified after bounded recovery attempts`,
    { cause: lastVerificationError },
  );
}
