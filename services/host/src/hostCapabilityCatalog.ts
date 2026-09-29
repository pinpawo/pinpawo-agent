import {
  GENERAL_CAPABILITY_NAME,
  type AgentCapability,
} from '@pinpawo/pet-agent';
import {
  loadCapabilityDirectory,
  loadUserCapabilities,
  type LoadedCapability,
  type LoadedUserCapability,
} from './capabilityLoader';
import { loadStoredConfig, type StoredConfig } from './storage';
import { createExploreCapability } from './capabilities/explore';
import { loadGeneralCapability } from './capabilities/general';

type CapabilityCatalogSource = 'host' | 'configured' | 'directory';

type CapabilityCatalogEntry = Readonly<{
  capability: AgentCapability;
  activation: Readonly<{
    id: string;
    defaultEnabled: boolean;
  }>;
  source: CapabilityCatalogSource;
  sourceId: string;
  /** Required Host baselines are never governed by an enablement switch. */
  required: boolean;
  enabled: boolean;
}>;

export type CapabilityCatalogSnapshot = Readonly<{
  capabilities: readonly AgentCapability[];
}>;

export type HostCapabilityCatalogDeps = {
  loadConfiguredCapabilities: () => Promise<LoadedUserCapability[]>;
  createHostCapabilities: () => AgentCapability[];
};

export type HostCapabilityCatalogOptions = Partial<HostCapabilityCatalogDeps>;

const defaultDeps: HostCapabilityCatalogDeps = {
  loadConfiguredCapabilities: loadUserCapabilities,
  createHostCapabilities: () => [],
};

/** Host baseline shared by every Agent, regardless of its concrete Host. */
export function createHostBaselineCapabilities(): AgentCapability[] {
  const general = loadGeneralCapability();
  if (!general) {
    throw new Error('Host requires the built-in "general" Capability.');
  }
  return [general, createExploreCapability()];
}

function resolveEntryEnabled(
  entry: Omit<CapabilityCatalogEntry, 'enabled'>,
  config: Pick<StoredConfig, 'capabilities'>,
): boolean {
  if (entry.required) return true;
  return config.capabilities?.[entry.activation.id]
    ?? entry.activation.defaultEnabled;
}

function assertDistinctCapabilityNames(entries: readonly Omit<CapabilityCatalogEntry, 'enabled'>[]) {
  const byName = new Map<string, Omit<CapabilityCatalogEntry, 'enabled'>>();
  for (const entry of entries) {
    const previous = byName.get(entry.capability.name);
    if (previous) {
      throw new Error(
        `Capability "${entry.capability.name}" from ${entry.source}:${entry.sourceId} `
        + `conflicts with ${previous.source}:${previous.sourceId}`,
      );
    }
    byName.set(entry.capability.name, entry);
  }
}

function hostEntry(capability: AgentCapability): Omit<CapabilityCatalogEntry, 'enabled'> {
  return {
    capability,
    activation: {
      id: capability.name,
      defaultEnabled: true,
    },
    source: 'host',
    sourceId: 'host',
    required: capability.name === GENERAL_CAPABILITY_NAME,
  };
}

function loadedEntry(
  loaded: LoadedCapability,
  source: Extract<CapabilityCatalogSource, 'configured' | 'directory'>,
  sourceId: string,
): Omit<CapabilityCatalogEntry, 'enabled'> {
  return {
    capability: loaded.capability,
    activation: loaded.activation,
    source,
    sourceId: `${sourceId}:${loaded.sourceId}`,
    required: false,
  };
}

function createSnapshot(
  entries: readonly Omit<CapabilityCatalogEntry, 'enabled'>[],
  config: Pick<StoredConfig, 'capabilities'>,
): CapabilityCatalogSnapshot {
  assertDistinctCapabilityNames(entries);
  const resolvedEntries = entries.map((entry) => Object.freeze({
    ...entry,
    enabled: resolveEntryEnabled(entry, config),
  }));
  return Object.freeze({
    capabilities: Object.freeze(
      resolvedEntries
        .filter((entry) => entry.enabled)
        .map((entry) => entry.capability),
    ),
  });
}

/**
 * Shared Agent Capability owner for a Host.
 *
 * It owns Host baselines, configured external sources, name collision policy,
 * enablement resolution and immutable snapshots. Chat and Studio differ only
 * in the source snapshot they request from this catalog.
 */
export class HostCapabilityCatalog {
  private readonly deps: HostCapabilityCatalogDeps;
  private hostCapabilities: readonly AgentCapability[] = [];
  private configuredCapabilities: readonly LoadedUserCapability[] = [];

  constructor(options: HostCapabilityCatalogOptions = {}) {
    this.deps = { ...defaultDeps, ...options };
  }

  async load(): Promise<void> {
    const hostCapabilities = this.deps.createHostCapabilities();
    const configuredCapabilities = await this.deps.loadConfiguredCapabilities();
    this.assertConfiguredCapabilities(hostCapabilities, configuredCapabilities);
    this.hostCapabilities = Object.freeze([...hostCapabilities]);
    this.configuredCapabilities = Object.freeze([...configuredCapabilities]);
  }

  /** Resolve the configured Host snapshot using the current Chat configuration. */
  getSnapshot(
    config: Pick<StoredConfig, 'capabilities'> = loadStoredConfig(),
  ): CapabilityCatalogSnapshot {
    return createSnapshot(
      [
        ...this.hostCapabilities.map(hostEntry),
        ...this.configuredCapabilities.map((loaded) => (
          loadedEntry(loaded, 'configured', 'configured')
        )),
      ],
      config,
    );
  }

  /**
   * Resolve one explicit directory through the same catalog contract.
   * Studio uses this to load each Pet's CAPABILITY.md collection; its assembly
   * decides whether that Pet uses the general fallback or an explicit default.
   */
  async createDirectorySnapshot(options: {
    rootDir: string;
    sourceId: string;
  }): Promise<CapabilityCatalogSnapshot> {
    const loaded = await loadCapabilityDirectory(options.rootDir);
    const hostEntries = this.hostCapabilities.map(hostEntry).filter((entry) => entry.required);
    return createSnapshot(
      [
        ...hostEntries,
        ...loaded.map((entry) => loadedEntry(entry, 'directory', options.sourceId)),
      ],
      { capabilities: Object.fromEntries(
        loaded.map(({ activation }) => [activation.id, true]),
      ) },
    );
  }

  private assertConfiguredCapabilities(
    hostCapabilities: readonly AgentCapability[],
    configuredCapabilities: readonly LoadedUserCapability[],
  ): void {
    assertDistinctCapabilityNames([
      ...hostCapabilities.map(hostEntry),
      ...configuredCapabilities.map((loaded) => (
        loadedEntry(loaded, 'configured', 'configured')
      )),
    ]);
  }
}
