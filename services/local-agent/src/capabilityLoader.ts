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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { AgentCapability } from '@pinpawo/pet-agent';
import type { CapabilityMeta } from '@pinpawo/pet-agent';
import { config } from './config';

/** Default user-global capabilities directory — always scanned. */
export const DEFAULT_CAPABILITIES_DIR = resolve(homedir(), '.pinpawo', 'capabilities');

/** Expand ~ in a path string. */
function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return homedir() + p.slice(1);
  return p;
}

/**
 * Resolve all directories to scan for capability plugins.
 * Order: default dir first, then extra dirs from config/env.
 * Deduplicates by resolved absolute path.
 */
export function resolveCapabilityDirs(): string[] {
  const extra = config.capabilityDirs.map((d) => resolve(expandHome(d)));
  const all = [DEFAULT_CAPABILITIES_DIR, ...extra];
  // deduplicate by resolved path
  return [...new Map(all.map((d) => [d, d])).values()];
}

export type LoadedUserCapability = {
  meta: CapabilityMeta;
  capability: AgentCapability;
};

/**
 * Load a single directory of capability plugins.
 * Returns only valid, successfully-loaded plugins; skips bad ones with a warning.
 */
async function loadCapabilitiesFromDir(
  dir: string,
  seenIds: Set<string>,
): Promise<LoadedUserCapability[]> {
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const loaded: LoadedUserCapability[] = [];

  for (const entry of entries) {
    const pluginDir = resolve(dir, entry.name);
    const manifestPath = resolve(pluginDir, 'manifest.json');
    const indexPath = resolve(pluginDir, 'index.js');

    if (!existsSync(manifestPath) || !existsSync(indexPath)) {
      console.warn(`[capabilities] skipping "${entry.name}" in ${dir}: missing manifest.json or index.js`);
      continue;
    }

    let meta: CapabilityMeta;
    try {
      meta = JSON.parse(readFileSync(manifestPath, 'utf-8')) as CapabilityMeta;
      if (!meta.id || !meta.name) throw new Error('manifest must have id and name');
    } catch (err) {
      console.warn(`[capabilities] "${entry.name}" manifest.json invalid:`, err instanceof Error ? err.message : err);
      continue;
    }

    if (seenIds.has(meta.id)) {
      console.warn(`[capabilities] duplicate capability id "${meta.id}" in ${dir} — skipped`);
      continue;
    }

    try {
      const mod = await import(indexPath) as { createCapability?: () => AgentCapability; default?: () => AgentCapability };
      const factory = mod.createCapability ?? mod.default;
      if (typeof factory !== 'function') {
        console.warn(`[capabilities] "${entry.name}" index.js must export createCapability() — skipped`);
        continue;
      }
      const capability = factory();
      seenIds.add(meta.id);
      loaded.push({ meta, capability });
      console.log(`[capabilities] loaded "${meta.name}" (${meta.id}) from ${dir}`);
    } catch (err) {
      console.warn(`[capabilities] failed to load "${entry.name}":`, err instanceof Error ? err.message : err);
    }
  }

  return loaded;
}

/**
 * Scan all configured capability directories and load every valid plugin.
 * Directories: ~/.pinpawo/capabilities/ (default) + config.capabilityDirs + PINPAWO_CAPABILITY_DIRS env.
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
    const entries = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const entry of entries) {
      const manifestPath = resolve(dir, entry.name, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(manifestPath, 'utf-8')) as CapabilityMeta;
        if (!meta.id || !meta.name || seenIds.has(meta.id)) continue;
        seenIds.add(meta.id);
        manifests.push(meta);
      } catch {
        // ignore malformed manifests
      }
    }
  }

  return manifests;
}
