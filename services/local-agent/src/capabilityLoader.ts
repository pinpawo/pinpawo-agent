/**
 * Loads directory-authored capabilities from CAPABILITY.md.
 *
 * The Markdown frontmatter owns routing metadata and required Toolkit
 * dependencies. The body is the immutable instruction document. JavaScript is
 * optional and, when declared through `entry`, may only export
 * `lifecycle.finalize`.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CAPABILITY_DOCUMENT_FILE_NAME,
  CAPABILITY_DOCUMENT_MAX_BYTES as CORE_CAPABILITY_DOCUMENT_MAX_BYTES,
  defineCapability,
  defineCapabilityDocumentSource,
  defineInstructionDocument,
  GENERAL_CAPABILITY_NAME,
  parseCapabilityDocument,
  type AgentCapability,
  type CapabilityDocumentFrontmatter,
  type CapabilityLifecycle,
} from '@pinpawo/pet-agent';
import type { CapabilityMeta } from './capabilityRegistry';
import { loadStoredConfig } from './storage';

export const DEFAULT_CAPABILITIES_DIR = resolve(homedir(), '.pinpawo', 'capabilities');
export const CAPABILITY_DOCUMENT_NAME = CAPABILITY_DOCUMENT_FILE_NAME;
export const CAPABILITY_DOCUMENT_MAX_BYTES = CORE_CAPABILITY_DOCUMENT_MAX_BYTES;

type CapabilityFrontmatter = CapabilityDocumentFrontmatter;

export type LoadedCapability = {
  meta: CapabilityMeta;
  capability: AgentCapability;
};

/** Global user-registry compatibility name. */
export type LoadedUserCapability = LoadedCapability;

export type CapabilityPluginValidationResult = {
  ok: boolean;
  rootDir: string;
  capabilityPath: string;
  entryPath: string | null;
  meta: CapabilityMeta | null;
  capability: AgentCapability | null;
  errors: string[];
  warnings: string[];
};

function expandHome(path: string): string {
  if (path === '~' || path.startsWith('~/')) return homedir() + path.slice(1);
  return path;
}

function isDirectoryEntry(root: string, entryName: string): boolean {
  try {
    return statSync(resolve(root, entryName)).isDirectory();
  } catch {
    return false;
  }
}

export function resolveCapabilityDirs(): string[] {
  const fromEnv = process.env.PINPAWO_CAPABILITY_DIRS?.split(':').filter(Boolean) ?? [];
  const fromStored = loadStoredConfig().capability_dirs ?? [];
  const all = [
    DEFAULT_CAPABILITIES_DIR,
    ...fromEnv.map((dir) => resolve(expandHome(dir))),
    ...fromStored.map((dir) => resolve(expandHome(dir))),
  ];
  return [...new Set(all)];
}

export const parseFrontmatterDocument = parseCapabilityDocument;

function resolveContainedEntry(rootDir: string, entry: string): string {
  if (isAbsolute(entry)) {
    throw new Error('frontmatter "entry" must be relative to the Capability directory');
  }
  const entryPath = resolve(rootDir, entry);
  const relativePath = relative(rootDir, entryPath);
  if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('frontmatter "entry" must stay inside the Capability directory');
  }
  if (!existsSync(entryPath)) {
    throw new Error(`Capability entry does not exist: ${entryPath}`);
  }
  const realRoot = realpathSync(rootDir);
  const realEntry = realpathSync(entryPath);
  const realRelative = relative(realRoot, realEntry);
  if (realRelative === '..' || realRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('frontmatter "entry" must not escape through a symlink');
  }
  return entryPath;
}

async function loadFinalizeLifecycle(entryPath: string): Promise<CapabilityLifecycle> {
  const url = pathToFileURL(entryPath);
  url.searchParams.set('v', String(statSync(entryPath).mtimeMs));
  const module = await import(url.href) as Record<string, unknown>;
  const exportedKeys = Object.keys(module);
  if (exportedKeys.some((key) => key !== 'lifecycle')) {
    throw new Error(`${entryPath}: entry may only export lifecycle`);
  }
  const lifecycle = module.lifecycle as Record<string, unknown> | undefined;
  if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) {
    throw new Error(`${entryPath}: entry must export a lifecycle object`);
  }
  const lifecycleKeys = Object.keys(lifecycle);
  if (lifecycleKeys.some((key) => key !== 'finalize')) {
    throw new Error(`${entryPath}: lifecycle may only contain finalize`);
  }
  if (typeof lifecycle.finalize !== 'function') {
    throw new Error(`${entryPath}: lifecycle.finalize must be a function`);
  }
  return { finalize: lifecycle.finalize as CapabilityLifecycle['finalize'] };
}

function toMeta(frontmatter: CapabilityFrontmatter): CapabilityMeta {
  return {
    id: frontmatter.name,
    name: frontmatter.name,
    description: frontmatter.description,
    icon: frontmatter.icon ?? 'wand.and.stars',
    color: frontmatter.color ?? 'purple',
    defaultEnabled: frontmatter.defaultEnabled ?? true,
    builtIn: false,
  };
}

function validateUserCapabilityName(name: string, path: string) {
  if (name === GENERAL_CAPABILITY_NAME) {
    throw new Error(
      `${path}: Capability name "${GENERAL_CAPABILITY_NAME}" is reserved by the local-agent host`,
    );
  }
}

export async function validateCapabilityPlugin(
  rootDir: string,
): Promise<CapabilityPluginValidationResult> {
  const dir = resolve(expandHome(rootDir));
  const capabilityPath = resolve(dir, CAPABILITY_DOCUMENT_NAME);
  const result: CapabilityPluginValidationResult = {
    ok: false,
    rootDir: dir,
    capabilityPath,
    entryPath: null,
    meta: null,
    capability: null,
    errors: [],
    warnings: [],
  };
  if (!existsSync(capabilityPath)) {
    result.errors.push(`missing ${CAPABILITY_DOCUMENT_NAME}`);
    return result;
  }

  try {
    const source = readFileSync(capabilityPath, 'utf8');
    const { frontmatter, body } = parseFrontmatterDocument(source, capabilityPath);
    validateUserCapabilityName(frontmatter.name, capabilityPath);
    const lifecycle = frontmatter.entry
      ? await loadFinalizeLifecycle(
        result.entryPath = resolveContainedEntry(dir, frontmatter.entry),
      )
      : undefined;
    result.meta = toMeta(frontmatter);
    result.capability = defineCapability({
      name: frontmatter.name,
      description: frontmatter.description,
      uses: frontmatter.uses,
      instructions: defineInstructionDocument({
        content: body,
      }),
      document: defineCapabilityDocumentSource({
        filePath: capabilityPath,
        content: source,
      }),
      ...(lifecycle ? { lifecycle } : {}),
    });
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }

  result.ok = result.errors.length === 0;
  return result;
}

async function loadCapabilitiesFromDir(
  dir: string,
  seenIds: Set<string>,
): Promise<LoadedUserCapability[]> {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectoryEntry(dir, entry.name)));
  const loaded: LoadedUserCapability[] = [];

  for (const entry of entries) {
    const capabilityDir = resolve(dir, entry.name);
    const validation = await validateCapabilityPlugin(capabilityDir);
    if (!validation.ok || !validation.meta || !validation.capability) {
      if (existsSync(validation.capabilityPath)) {
        console.warn(`[capabilities] "${entry.name}" invalid: ${validation.errors.join('; ')}`);
      } else {
        warnLegacyCapabilityDirectory(capabilityDir, entry.name);
      }
      continue;
    }
    if (seenIds.has(validation.meta.id)) {
      console.warn(`[capabilities] duplicate capability id "${validation.meta.id}" in ${dir} — skipped`);
      continue;
    }
    seenIds.add(validation.meta.id);
    loaded.push({
      meta: validation.meta,
      capability: validation.capability,
    });
  }
  return loaded;
}

/**
 * Strictly load one explicit Capability collection root.
 *
 * Unlike the global user registry scan, an explicit root is configuration by
 * convention: every child directory must be a valid Capability and duplicate
 * names are errors. A missing root represents an empty collection.
 */
export async function loadCapabilityDirectory(
  rootDir: string,
): Promise<LoadedCapability[]> {
  const dir = resolve(expandHome(rootDir));
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name));
  const loaded: LoadedCapability[] = [];
  const seenIds = new Set<string>();

  for (const entry of entries) {
    const capabilityDir = resolve(dir, entry.name);
    if (entry.isSymbolicLink() && !isDirectoryEntry(dir, entry.name)) {
      throw new Error(
        `Invalid Capability directory "${capabilityDir}": symlink target is unavailable or not a directory`,
      );
    }
    const validation = await validateCapabilityPlugin(capabilityDir);
    if (!validation.ok || !validation.meta || !validation.capability) {
      const reason = validation.errors.length > 0
        ? validation.errors.join('; ')
        : `missing ${CAPABILITY_DOCUMENT_NAME}`;
      throw new Error(`Invalid Capability directory "${capabilityDir}": ${reason}`);
    }
    if (seenIds.has(validation.meta.id)) {
      throw new Error(
        `Duplicate Capability "${validation.meta.id}" in "${dir}"`,
      );
    }
    seenIds.add(validation.meta.id);
    loaded.push({
      meta: validation.meta,
      capability: validation.capability,
    });
  }

  return loaded;
}

const warnedLegacyCapabilityDirs = new Set<string>();

function warnLegacyCapabilityDirectory(dir: string, name: string) {
  if (
    warnedLegacyCapabilityDirs.has(dir)
    || (!existsSync(resolve(dir, 'manifest.json')) && !existsSync(resolve(dir, 'index.js')))
  ) {
    return;
  }
  warnedLegacyCapabilityDirs.add(dir);
  console.warn(
    `[capabilities] "${name}" uses the removed manifest.json/index.js format and was skipped; `
    + 'migrate it to CAPABILITY.md',
  );
}

export async function loadUserCapabilities(): Promise<LoadedUserCapability[]> {
  const seenIds = new Set<string>();
  const loaded: LoadedUserCapability[] = [];
  for (const dir of resolveCapabilityDirs()) {
    loaded.push(...await loadCapabilitiesFromDir(dir, seenIds));
  }
  return loaded;
}

export function readUserCapabilityManifests(): CapabilityMeta[] {
  const seenIds = new Set<string>();
  const metas: CapabilityMeta[] = [];
  for (const dir of resolveCapabilityDirs()) {
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectoryEntry(dir, entry.name)));
    for (const entry of entries) {
      const capabilityDir = resolve(dir, entry.name);
      const capabilityPath = resolve(capabilityDir, CAPABILITY_DOCUMENT_NAME);
      if (!existsSync(capabilityPath)) {
        warnLegacyCapabilityDirectory(capabilityDir, entry.name);
        continue;
      }
      try {
        const { frontmatter } = parseFrontmatterDocument(
          readFileSync(capabilityPath, 'utf8'),
          capabilityPath,
        );
        validateUserCapabilityName(frontmatter.name, capabilityPath);
        if (seenIds.has(frontmatter.name)) continue;
        seenIds.add(frontmatter.name);
        metas.push(toMeta(frontmatter));
      } catch {
        // Listing deliberately skips malformed definitions; validation reports details.
      }
    }
  }
  return metas;
}
