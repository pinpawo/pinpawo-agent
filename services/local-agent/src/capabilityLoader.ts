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
  defineCapability,
  defineInstructionDocument,
  type AgentCapability,
  type CapabilityLifecycle,
} from '@pinpawo/pet-agent';
import type { CapabilityMeta } from './capabilityRegistry';
import { loadStoredConfig } from './storage';

export const DEFAULT_CAPABILITIES_DIR = resolve(homedir(), '.pinpawo', 'capabilities');
export const CAPABILITY_DOCUMENT_NAME = 'CAPABILITY.md';
export const CAPABILITY_DOCUMENT_MAX_BYTES = 64 * 1024;

type CapabilityFrontmatter = {
  name: string;
  description: string;
  uses: string[];
  version: 1;
  icon?: string;
  color?: string;
  defaultEnabled?: boolean;
  entry?: string;
};

export type LoadedUserCapability = {
  meta: CapabilityMeta;
  capability: AgentCapability;
};

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

function parseScalar(raw: string): string | boolean | number {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      throw new Error(`invalid quoted frontmatter value: ${value}`);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function parseUsesInline(raw: string): string[] {
  const value = raw.trim();
  if (value === '[]') return [];
  if (!value.startsWith('[') || !value.endsWith(']')) {
    throw new Error('frontmatter "uses" must be a YAML list');
  }
  return value
    .slice(1, -1)
    .split(',')
    .map((item) => String(parseScalar(item)).trim())
    .filter(Boolean);
}

export function parseFrontmatterDocument(
  source: string,
  path: string,
): { frontmatter: CapabilityFrontmatter; body: string } {
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error(`${path}: must start with YAML frontmatter`);
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) {
    throw new Error(`${path}: frontmatter closing delimiter is missing`);
  }

  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 5).trim();
  const raw: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const [index, line] of header.split('\n').entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (listItem) {
      if (!listKey) {
        throw new Error(`${path}:${String(index + 2)}: list item has no field`);
      }
      const items = raw[listKey];
      if (!Array.isArray(items)) {
        throw new Error(`${path}:${String(index + 2)}: invalid list`);
      }
      items.push(String(parseScalar(listItem[1])).trim());
      continue;
    }

    const field = line.match(/^([A-Za-z][A-Za-z0-9_]*):(?:\s*(.*))?$/);
    if (!field) {
      throw new Error(`${path}:${String(index + 2)}: unsupported frontmatter syntax`);
    }
    const [, key, value = ''] = field;
    listKey = null;
    if (key === 'uses') {
      raw[key] = value.trim() ? parseUsesInline(value) : [];
      listKey = value.trim() ? null : key;
    } else {
      raw[key] = parseScalar(value);
    }
  }

  const supported = new Set([
    'name',
    'description',
    'uses',
    'version',
    'icon',
    'color',
    'defaultEnabled',
    'entry',
  ]);
  const unknown = Object.keys(raw).filter((key) => !supported.has(key));
  if (unknown.length > 0) {
    throw new Error(`${path}: unsupported frontmatter field(s): ${unknown.join(', ')}`);
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    throw new Error(`${path}: "name" must be a non-empty string`);
  }
  if (typeof raw.description !== 'string' || !raw.description.trim()) {
    throw new Error(`${path}: "description" must be a non-empty string`);
  }
  if (
    !Array.isArray(raw.uses)
    || raw.uses.some((name) => typeof name !== 'string' || !name.trim())
  ) {
    throw new Error(`${path}: "uses" must contain Toolkit names`);
  }
  if (new Set(raw.uses).size !== raw.uses.length) {
    throw new Error(`${path}: "uses" must not contain duplicate Toolkit names`);
  }
  if (raw.version !== 1) {
    throw new Error(`${path}: "version" must be 1`);
  }
  if (!body) {
    throw new Error(`${path}: Markdown body must not be empty`);
  }
  if (Buffer.byteLength(body, 'utf8') > CAPABILITY_DOCUMENT_MAX_BYTES) {
    throw new Error(`${path}: Markdown body exceeds ${String(CAPABILITY_DOCUMENT_MAX_BYTES)} bytes`);
  }

  for (const field of ['icon', 'color', 'entry'] as const) {
    if (raw[field] !== undefined && (typeof raw[field] !== 'string' || !raw[field].trim())) {
      throw new Error(`${path}: "${field}" must be a non-empty string when present`);
    }
  }
  if (raw.defaultEnabled !== undefined && typeof raw.defaultEnabled !== 'boolean') {
    throw new Error(`${path}: "defaultEnabled" must be a boolean when present`);
  }

  return {
    frontmatter: raw as CapabilityFrontmatter,
    body,
  };
}

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
