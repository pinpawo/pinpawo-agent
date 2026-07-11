/**
 * Capability plugin loader.
 *
 * Discovers and loads user-defined capabilities from ~/.pinpawo/capabilities/.
 * Each capability lives in its own sub-directory:
 *
 *   ~/.pinpawo/capabilities/
 *     my-capability/
 *       manifest.json   ← UI metadata (id, name, icon, …)
 *       index.js        ← exports createCapability(): AgentCapability
 *
 * Built-in capabilities are wired separately in agentChannel.ts with their
 * runtime dependencies (savePost, markUsed, …); this loader only handles
 * user-defined extension capabilities.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { AgentCapability } from '@pinpawo/pet-agent';
import type { CapabilityMeta } from './capabilityRegistry';
import { loadStoredConfig } from './storage';

/** Default user-global capabilities directory — always scanned. */
export const DEFAULT_CAPABILITIES_DIR = resolve(homedir(), '.pinpawo', 'capabilities');

/** Expand ~ in a path string. */
function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return homedir() + p.slice(1);
  return p;
}

function isDirectoryEntry(root: string, entryName: string): boolean {
  try {
    return statSync(resolve(root, entryName)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve all directories to scan for capability plugins.
 * Order: default dir first, then extra dirs from config/env.
 * Deduplicates by resolved absolute path.
 */
export function resolveCapabilityDirs(): string[] {
  const fromEnv = process.env.PINPAWO_CAPABILITY_DIRS?.split(':').filter(Boolean) ?? [];
  const fromStored = loadStoredConfig().capability_dirs ?? [];
  const extra = [...fromEnv, ...fromStored].map((d) => resolve(expandHome(d)));
  const all = [DEFAULT_CAPABILITIES_DIR, ...extra];
  // deduplicate by resolved path
  return [...new Map(all.map((d) => [d, d])).values()];
}

export type LoadedUserCapability = {
  meta: CapabilityMeta;
  capability: AgentCapability;
};

export type CapabilityPluginValidationResult = {
  ok: boolean;
  rootDir: string;
  manifestPath: string;
  indexPath: string;
  meta: CapabilityMeta | null;
  capability: AgentCapability | null;
  errors: string[];
  warnings: string[];
};

function readStringField(value: Record<string, unknown>, key: keyof CapabilityMeta, source: string): string {
  const raw = value[key];
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`${source}: "${key}" must be a non-empty string`);
  }
  return raw;
}

function readBooleanField(value: Record<string, unknown>, key: keyof CapabilityMeta, source: string): boolean {
  const raw = value[key];
  if (typeof raw !== 'boolean') {
    throw new Error(`${source}: "${key}" must be a boolean`);
  }
  return raw;
}

export function parseCapabilityManifest(raw: unknown, source: string): CapabilityMeta {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${source}: manifest must be a JSON object`);
  }
  const value = raw as Record<string, unknown>;
  const meta: CapabilityMeta = {
    id: readStringField(value, 'id', source),
    name: readStringField(value, 'name', source),
    description: readStringField(value, 'description', source),
    icon: readStringField(value, 'icon', source),
    color: readStringField(value, 'color', source),
    defaultEnabled: readBooleanField(value, 'defaultEnabled', source),
    builtIn: readBooleanField(value, 'builtIn', source),
  };
  if (value.comingSoon !== undefined) {
    if (typeof value.comingSoon !== 'boolean') {
      throw new Error(`${source}: "comingSoon" must be a boolean when present`);
    }
    meta.comingSoon = value.comingSoon;
  }
  if (meta.builtIn !== false) {
    throw new Error(`${source}: user capability manifest must set "builtIn": false`);
  }
  return meta;
}

function assertPluginCapability(meta: CapabilityMeta, capability: AgentCapability, source: string) {
  if (!capability || typeof capability !== 'object') {
    throw new Error(`${source}: createCapability() must return a capability object`);
  }
  if (typeof capability.name !== 'string' || !capability.name.trim()) {
    throw new Error(`${source}: capability.name must be a non-empty string`);
  }
  if (capability.name !== meta.id) {
    throw new Error(`${source}: manifest.id (${meta.id}) must match capability.name (${capability.name})`);
  }
  if (typeof capability.description !== 'string' || !capability.description.trim()) {
    throw new Error(`${source}: capability.description must be a non-empty string`);
  }
  if (typeof capability.createRuntime !== 'function') {
    throw new Error(`${source}: capability.createRuntime must be a function`);
  }
  if (capability.availability) {
    if (typeof capability.availability.check !== 'function') {
      throw new Error(`${source}: capability.availability.check must be a function`);
    }
    const cache = capability.availability.cache;
    if (cache !== undefined && cache !== 'startup' && cache !== 'none') {
      throw new Error(`${source}: capability.availability.cache must be "startup" or "none"`);
    }
  }
}

async function importCapability(indexPath: string): Promise<AgentCapability> {
  const url = pathToFileURL(indexPath);
  url.searchParams.set('v', String(statSync(indexPath).mtimeMs));
  const mod = await import(url.href) as { createCapability?: () => AgentCapability; default?: () => AgentCapability };
  const factory = mod.createCapability ?? mod.default;
  if (typeof factory !== 'function') {
    throw new Error('index.js must export createCapability() or default');
  }
  return factory();
}

export async function validateCapabilityPlugin(rootDir: string): Promise<CapabilityPluginValidationResult> {
  const dir = resolve(expandHome(rootDir));
  const manifestPath = resolve(dir, 'manifest.json');
  const indexPath = resolve(dir, 'index.js');
  const result: CapabilityPluginValidationResult = {
    ok: false,
    rootDir: dir,
    manifestPath,
    indexPath,
    meta: null,
    capability: null,
    errors: [],
    warnings: [],
  };

  if (!existsSync(manifestPath)) result.errors.push('missing manifest.json');
  if (!existsSync(indexPath)) result.errors.push('missing index.js');
  if (result.errors.length > 0) return result;

  try {
    result.meta = parseCapabilityManifest(
      JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown,
      manifestPath,
    );
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }

  if (!result.meta) return result;

  try {
    result.capability = await importCapability(indexPath);
    assertPluginCapability(result.meta, result.capability, indexPath);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }

  result.ok = result.errors.length === 0;
  return result;
}

/**
 * Load a single directory of capability plugins.
 * Returns only valid, successfully-loaded plugins; skips bad ones with a warning.
 */
async function loadCapabilitiesFromDir(
  dir: string,
  seenIds: Set<string>,
): Promise<LoadedUserCapability[]> {
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() || (d.isSymbolicLink() && isDirectoryEntry(dir, d.name)));
  const loaded: LoadedUserCapability[] = [];

  for (const entry of entries) {
    const pluginDir = resolve(dir, entry.name);
    const manifestPath = resolve(pluginDir, 'manifest.json');
    const indexPath = resolve(pluginDir, 'index.js');

    if (!existsSync(manifestPath) || !existsSync(indexPath)) {
      console.warn(`[capabilities] skipping "${entry.name}" in ${dir}: missing manifest.json or index.js`);
      continue;
    }

    const validation = await validateCapabilityPlugin(pluginDir);
    if (!validation.ok || !validation.meta || !validation.capability) {
      console.warn(`[capabilities] "${entry.name}" invalid:`, validation.errors.join('; '));
      continue;
    }
    const { meta, capability } = validation;

    if (seenIds.has(meta.id)) {
      console.warn(`[capabilities] duplicate capability id "${meta.id}" in ${dir} — skipped`);
      continue;
    }

    seenIds.add(meta.id);
    loaded.push({ meta, capability });
    console.log(`[capabilities] loaded "${meta.name}" (${meta.id}) from ${dir}`);
  }

  return loaded;
}

/**
 * Scan all configured capability directories and load every valid plugin.
 * Directories: ~/.pinpawo/capabilities/ (default) plus stored and environment-configured paths.
 * Duplicate IDs across directories are skipped (first-seen wins).
 */
export async function loadUserCapabilities(): Promise<LoadedUserCapability[]> {
  const dirs = resolveCapabilityDirs();
  const seenIds = new Set<string>();
  const all: LoadedUserCapability[] = [];

  for (const dir of dirs) {
    const results = await loadCapabilitiesFromDir(dir, seenIds);
    all.push(...results);
  }

  return all;
}

/**
 * Read all user capability manifests across all configured directories
 * without loading the JS modules.  Used for health reporting / listing.
 */
export function readUserCapabilityManifests(): CapabilityMeta[] {
  const dirs = resolveCapabilityDirs();
  const seenIds = new Set<string>();
  const manifests: CapabilityMeta[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || (d.isSymbolicLink() && isDirectoryEntry(dir, d.name)));
    for (const entry of entries) {
      const manifestPath = resolve(dir, entry.name, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const meta = parseCapabilityManifest(
          JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown,
          manifestPath,
        );
        if (seenIds.has(meta.id)) continue;
        seenIds.add(meta.id);
        manifests.push(meta);
      } catch {
        // ignore malformed manifests
      }
    }
  }

  return manifests;
}
