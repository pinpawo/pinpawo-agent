import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { LocalAgentRuntimeConfig, LocalAgentWorkspaceConfig } from './runtimeConfig';
import { attachWorkspaceConfig, deriveWorkspaceId, deriveWorkspaceName, resolveUserDir } from './runtimeConfig';

export type WorkspaceRegistryEntry = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  lastOpenedAt?: string;
};

export type WorkspaceListEntry = WorkspaceRegistryEntry & {
  active: boolean;
};

export type WorkspaceRegistry = {
  version: 1;
  workspaces: WorkspaceRegistryEntry[];
};

const DEFAULT_WORKSPACE_REGISTRY_PATH = resolve(homedir(), '.pinpawo', 'workspaces.json');

export function workspaceRegistryPath() {
  return DEFAULT_WORKSPACE_REGISTRY_PATH;
}

export function loadWorkspaceRegistry(filePath = DEFAULT_WORKSPACE_REGISTRY_PATH): WorkspaceRegistry {
  try {
    const raw = readFileSync(filePath, 'utf8');
    return parseWorkspaceRegistry(JSON.parse(raw));
  } catch {
    return { version: 1, workspaces: [] };
  }
}

export function saveWorkspaceRegistry(
  registry: WorkspaceRegistry,
  filePath = DEFAULT_WORKSPACE_REGISTRY_PATH,
) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

export function listWorkspaceEntries(input: {
  runtimeConfig?: LocalAgentRuntimeConfig;
  registryPath?: string;
} = {}): WorkspaceListEntry[] {
  const registry = loadWorkspaceRegistry(input.registryPath);
  const activeWorkspace = input.runtimeConfig
    ? workspaceFromRuntimeConfig(input.runtimeConfig)
    : null;
  const entries = new Map<string, WorkspaceRegistryEntry>();

  for (const entry of registry.workspaces) {
    entries.set(entry.id, entry);
  }
  if (activeWorkspace) {
    const existing = entries.get(activeWorkspace.id);
    entries.set(activeWorkspace.id, {
      ...activeWorkspace,
      createdAt: existing?.createdAt ?? activeWorkspace.createdAt,
      ...(existing?.lastOpenedAt ? { lastOpenedAt: existing.lastOpenedAt } : {}),
    });
  }

  const activeId = activeWorkspace?.id ?? null;
  return [...entries.values()]
    .map((entry) => ({
      ...entry,
      active: entry.id === activeId,
    }))
    .sort(compareWorkspaceEntries);
}

export function selectWorkspaceEntry(input: {
  workspaceId: string;
  registryPath?: string;
  now?: string;
}): WorkspaceRegistryEntry {
  const workspaceId = input.workspaceId.trim();
  const registry = loadWorkspaceRegistry(input.registryPath);
  const entry = registry.workspaces.find((item) => item.id === workspaceId);
  if (!entry) {
    throw new Error(`workspace not found: ${workspaceId}`);
  }
  const selected = {
    ...entry,
    lastOpenedAt: input.now ?? new Date().toISOString(),
  };
  saveWorkspaceRegistry({
    version: 1,
    workspaces: registry.workspaces.map((item) => item.id === selected.id ? selected : item),
  }, input.registryPath);
  return selected;
}

export function upsertWorkspaceEntry(input: {
  rootPath: string;
  id?: string;
  name?: string;
  registryPath?: string;
  now?: string;
}): WorkspaceRegistryEntry {
  const rootPath = resolveUserDir(input.rootPath);
  const id = input.id?.trim() || deriveWorkspaceId(rootPath);
  const now = input.now ?? new Date().toISOString();
  const registry = loadWorkspaceRegistry(input.registryPath);
  const existing = registry.workspaces.find((item) => item.id === id);
  const entry: WorkspaceRegistryEntry = {
    id,
    name: input.name?.trim() || existing?.name || deriveWorkspaceName(rootPath),
    rootPath,
    createdAt: existing?.createdAt ?? now,
    lastOpenedAt: now,
  };

  saveWorkspaceRegistry({
    version: 1,
    workspaces: [
      ...registry.workspaces.filter((item) => item.id !== id),
      entry,
    ].sort(compareWorkspaceEntries),
  }, input.registryPath);
  return entry;
}

export function workspaceFromRuntimeConfig(runtimeConfig: LocalAgentRuntimeConfig): WorkspaceRegistryEntry {
  const workspace = runtimeConfig.workspace ?? attachWorkspaceConfig(runtimeConfig).workspace!;
  return workspaceRegistryEntryFromWorkspace(workspace);
}

function workspaceRegistryEntryFromWorkspace(workspace: LocalAgentWorkspaceConfig): WorkspaceRegistryEntry {
  return {
    id: workspace.id,
    name: workspace.name,
    rootPath: workspace.rootPath,
    createdAt: new Date(0).toISOString(),
  };
}

function parseWorkspaceRegistry(raw: unknown): WorkspaceRegistry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: 1, workspaces: [] };
  }
  const record = raw as Record<string, unknown>;
  const rawWorkspaces = Array.isArray(record.workspaces) ? record.workspaces : [];
  return {
    version: 1,
    workspaces: rawWorkspaces.flatMap((item) => {
      const parsed = parseWorkspaceEntry(item);
      return parsed ? [parsed] : [];
    }),
  };
}

function parseWorkspaceEntry(raw: unknown): WorkspaceRegistryEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const rootPath = readString(record.rootPath);
  const id = readString(record.id) || (rootPath ? deriveWorkspaceId(rootPath) : '');
  const name = readString(record.name) || (rootPath ? deriveWorkspaceName(rootPath) : '');
  const createdAt = readString(record.createdAt) || new Date(0).toISOString();
  const lastOpenedAt = readString(record.lastOpenedAt);
  if (!id || !name || !rootPath) return null;
  return {
    id,
    name,
    rootPath: resolveUserDir(rootPath),
    createdAt,
    ...(lastOpenedAt ? { lastOpenedAt } : {}),
  };
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function compareWorkspaceEntries(a: WorkspaceListEntry | WorkspaceRegistryEntry, b: WorkspaceListEntry | WorkspaceRegistryEntry) {
  if ('active' in a && 'active' in b && a.active !== b.active) {
    return a.active ? -1 : 1;
  }
  const aTime = 'lastOpenedAt' in a && a.lastOpenedAt ? Date.parse(a.lastOpenedAt) : 0;
  const bTime = 'lastOpenedAt' in b && b.lastOpenedAt ? Date.parse(b.lastOpenedAt) : 0;
  if (aTime !== bTime) return bTime - aTime;
  return a.name.localeCompare(b.name);
}

export function workspaceRegistryExists(filePath = DEFAULT_WORKSPACE_REGISTRY_PATH) {
  try {
    readFileSync(filePath);
    return true;
  } catch {
    return false;
  }
}
