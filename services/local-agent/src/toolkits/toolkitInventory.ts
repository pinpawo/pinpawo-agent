import {
  type AgentToolkit,
  type ToolkitAvailability,
  evaluateToolkitAvailability,
  validateToolkitDefinition,
} from '@pinpawo/pet-agent';

export type ToolkitDefinitionSourceKind = 'host_builtin' | 'plugin';

/**
 * One deterministic Host input of Toolkit definitions.
 *
 * Sources are ordered by the Host. The inventory never silently reorders or
 * overwrites definitions, so the resulting provenance remains reproducible.
 */
export type ToolkitDefinitionSource = Readonly<{
  id: string;
  kind: ToolkitDefinitionSourceKind;
  definitions: readonly AgentToolkit[];
}>;

export type ToolkitDefinitionProvenance = Readonly<{
  sourceId: string;
  sourceKind: ToolkitDefinitionSourceKind;
  sourceIndex: number;
  definitionIndex: number;
}>;

export type ToolkitInventoryEntry = Readonly<{
  toolkit: AgentToolkit;
  provenance: ToolkitDefinitionProvenance;
  availability: ToolkitAvailability;
}>;

/**
 * Immutable Host projection shared by Chat, Studio, compiler diagnostics and
 * operation metadata. Runtime roots and execution bindings never enter it.
 */
export type HostToolkitInventorySnapshot = Readonly<{
  entries: readonly ToolkitInventoryEntry[];
  effectiveToolkits: readonly AgentToolkit[];
}>;

export type ToolkitAvailabilityResolver = (
  toolkit: AgentToolkit,
) => Promise<ToolkitAvailability>;

export type BuildHostToolkitInventoryOptions = Readonly<{
  sources: readonly ToolkitDefinitionSource[];
  startToolkitRuntimes?: (definitions: readonly AgentToolkit[]) => Promise<void>;
  resolveAvailability?: ToolkitAvailabilityResolver;
}>;

const defaultAvailabilityResolver: ToolkitAvailabilityResolver =
  evaluateToolkitAvailability;

function assertSource(source: ToolkitDefinitionSource, sourceIndex: number) {
  if (typeof source.id !== 'string' || !source.id.trim()) {
    throw new Error(`Toolkit definition source at index ${sourceIndex.toString()} must have an id`);
  }
  if (source.kind !== 'host_builtin' && source.kind !== 'plugin') {
    throw new Error(
      `Toolkit definition source "${source.id}" has unsupported kind "${String(source.kind)}"`,
    );
  }
  if (!Array.isArray(source.definitions)) {
    throw new Error(`Toolkit definition source "${source.id}" must provide definitions`);
  }
}

function describeProvenance(provenance: ToolkitDefinitionProvenance) {
  return `${provenance.sourceKind} source "${provenance.sourceId}"`
    + ` definition ${provenance.definitionIndex.toString()}`;
}

function freezeEntry(entry: ToolkitInventoryEntry): ToolkitInventoryEntry {
  return Object.freeze({
    toolkit: entry.toolkit,
    provenance: Object.isFrozen(entry.provenance)
      ? entry.provenance
      : Object.freeze({ ...entry.provenance }),
    availability: Object.freeze({ ...entry.availability }),
  });
}

function snapshotEntries(
  entries: readonly ToolkitInventoryEntry[],
): HostToolkitInventorySnapshot {
  const frozenEntries = Object.freeze(entries.map(freezeEntry));
  return Object.freeze({
    entries: frozenEntries,
    effectiveToolkits: Object.freeze(
      frozenEntries
        .filter(({ availability }) => availability.available)
        .map(({ toolkit }) => toolkit),
    ),
  });
}

const EMPTY_HOST_TOOLKIT_INVENTORY = snapshotEntries([]);

function collectDefinitions(sources: readonly ToolkitDefinitionSource[]) {
  const seenSourceIds = new Map<string, number>();
  const seenToolkitNames = new Map<string, ToolkitDefinitionProvenance>();
  const definitions: Array<{
    toolkit: AgentToolkit;
    provenance: ToolkitDefinitionProvenance;
  }> = [];

  sources.forEach((source, sourceIndex) => {
    assertSource(source, sourceIndex);
    const previousSourceIndex = seenSourceIds.get(source.id);
    if (previousSourceIndex !== undefined) {
      throw new Error(
        `Duplicate Toolkit definition source id "${source.id}" at indexes `
        + `${previousSourceIndex.toString()} and ${sourceIndex.toString()}`,
      );
    }
    seenSourceIds.set(source.id, sourceIndex);

    source.definitions.forEach((toolkit, definitionIndex) => {
      validateToolkitDefinition(toolkit);
      const provenance = Object.freeze({
        sourceId: source.id,
        sourceKind: source.kind,
        sourceIndex,
        definitionIndex,
      });
      const previous = seenToolkitNames.get(toolkit.name);
      if (previous) {
        throw new Error(
          `Duplicate Toolkit name "${toolkit.name}": ${describeProvenance(previous)} and `
          + describeProvenance(provenance),
        );
      }
      seenToolkitNames.set(toolkit.name, provenance);
      definitions.push({ toolkit, provenance });
    });
  });

  return definitions;
}

export async function buildHostToolkitInventory(
  options: BuildHostToolkitInventoryOptions,
): Promise<HostToolkitInventorySnapshot> {
  const definitions = collectDefinitions(options.sources);
  const toolkits = Object.freeze(definitions.map(({ toolkit }) => toolkit));

  // Duplicate definitions and malformed contracts fail before any dynamic
  // resource is acquired.
  await options.startToolkitRuntimes?.(toolkits);

  const resolveAvailability = options.resolveAvailability
    ?? defaultAvailabilityResolver;
  const entries = await Promise.all(definitions.map(async ({ toolkit, provenance }) => ({
    toolkit,
    provenance,
    availability: await resolveAvailability(toolkit),
  })));
  return snapshotEntries(entries);
}

/**
 * Report selected Toolkit definitions that are unavailable in the current
 * Host environment. This is static availability, not live Runtime diagnostics.
 */
export function reportUnavailableToolkitAvailability(
  inventory: HostToolkitInventorySnapshot,
  warn: (message: string) => void = console.warn,
): void {
  for (const { toolkit, provenance, availability } of inventory.entries) {
    if (availability.available) continue;
    warn(
      `[toolkits] Toolkit "${toolkit.name}" unavailable `
      + `(${describeProvenance(provenance)}): ${availability.reason}`,
    );
  }
}

function updateHostToolkitInventoryAvailability(
  inventory: HostToolkitInventorySnapshot,
  toolkitName: string,
  availability: ToolkitAvailability,
): HostToolkitInventorySnapshot {
  return snapshotEntries(inventory.entries.map((entry) => (
    entry.toolkit.name === toolkitName ? { ...entry, availability } : entry
  )));
}

/**
 * The single mutable Host owner of immutable Toolkit inventory generations.
 * Consumers retain this owner and read its current snapshot; they never copy
 * ownership into transport- or interface-specific state.
 */
export class HostToolkitInventoryStore {
  private current: HostToolkitInventorySnapshot;
  private definitionGeneration = 0;

  constructor(initial: HostToolkitInventorySnapshot = EMPTY_HOST_TOOLKIT_INVENTORY) {
    this.current = initial;
  }

  getSnapshot(): HostToolkitInventorySnapshot {
    return this.current;
  }

  replace(snapshot: HostToolkitInventorySnapshot): HostToolkitInventorySnapshot {
    this.current = snapshot;
    this.definitionGeneration += 1;
    return snapshot;
  }

  updateAvailability(
    toolkitName: string,
    availability: ToolkitAvailability,
  ): HostToolkitInventorySnapshot | null {
    if (!this.current.entries.some(({ toolkit }) => toolkit.name === toolkitName)) {
      return null;
    }
    this.current = updateHostToolkitInventoryAvailability(
      this.current,
      toolkitName,
      availability,
    );
    return this.current;
  }

  async refresh(
    toolkitName: string,
    resolveAvailability: ToolkitAvailabilityResolver = defaultAvailabilityResolver,
  ): Promise<HostToolkitInventorySnapshot | null> {
    const target = this.current.entries.find(({ toolkit }) => toolkit.name === toolkitName);
    if (!target) return null;
    const targetGeneration = this.definitionGeneration;

    const availability = await resolveAvailability(target.toolkit);
    const latest = this.current.entries.find(({ toolkit }) => toolkit.name === toolkitName);
    // Do not project a result from an older definition into a replacement
    // inventory generation that reused the same Toolkit name.
    if (
      targetGeneration !== this.definitionGeneration
      || !latest
      || latest.toolkit !== target.toolkit
    ) return null;
    return this.updateAvailability(toolkitName, availability);
  }
}
