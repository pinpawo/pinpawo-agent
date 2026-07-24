import type {
  AgentCapability,
  AgentToolkit,
  CapabilityAvailability,
  ToolkitAvailability,
} from '@pinpawo/pet-agent';

export type CapabilityAvailabilityRecord = {
  capability: AgentCapability;
  availability: CapabilityAvailability;
};

export type ToolkitAvailabilityRecord = {
  toolkit: AgentToolkit;
  availability: ToolkitAvailability;
};

const defaultAvailable: CapabilityAvailability = {
  available: true,
  reason: 'Capability availability is derived from required Toolkits',
};

const defaultToolkitAvailable: ToolkitAvailability = {
  available: true,
};

const cachedAvailability = new Map<string, CapabilityAvailabilityRecord>();
const cachedToolkitAvailability = new Map<string, ToolkitAvailabilityRecord>();

function unavailableToolkitFromError(error: unknown): ToolkitAvailability {
  return {
    available: false,
    reason: error instanceof Error ? error.message : 'availability check failed',
  };
}

export function getCachedCapabilityAvailability(name: string): CapabilityAvailability | null {
  return cachedAvailability.get(name)?.availability ?? null;
}

export async function resolveCapabilityAvailability(
  capability: AgentCapability,
  options: {
    force?: boolean;
    availableToolkits?: readonly AgentToolkit[];
  } = {},
): Promise<CapabilityAvailabilityRecord> {
  if (!options.force) {
    const cached = cachedAvailability.get(capability.name);
    if (cached) return cached;
  }

  const availableToolkitNames = options.availableToolkits
    ? new Set(options.availableToolkits.map((toolkit) => toolkit.name))
    : null;
  const missingToolkits = availableToolkitNames
    ? capability.uses.filter((name) => !availableToolkitNames.has(name))
    : [];
  const availability: CapabilityAvailability = missingToolkits.length > 0
    ? {
        available: false,
        reason: `required Toolkit unavailable: ${missingToolkits.join(', ')}`,
        metadata: { missingToolkitCount: missingToolkits.length },
      }
    : defaultAvailable;
  const record = { capability, availability };
  cachedAvailability.set(capability.name, record);
  return record;
}

export async function resolveAvailableCapabilities(
  capabilities: AgentCapability[],
  options: {
    force?: boolean;
    availableToolkits?: readonly AgentToolkit[];
  } = {},
): Promise<AgentCapability[]> {
  const records = await Promise.all(
    capabilities.map((capability) => resolveCapabilityAvailability(capability, options)),
  );
  return records
    .filter((record) => record.availability.available)
    .map((record) => record.capability);
}

export async function resolveToolkitAvailability(
  toolkit: AgentToolkit,
  options: { force?: boolean } = {},
): Promise<ToolkitAvailabilityRecord> {
  if (!options.force) {
    const cached = cachedToolkitAvailability.get(toolkit.name);
    if (cached) return cached;
  }

  const availability = toolkit.availability
    ? await Promise.resolve(toolkit.availability()).catch(unavailableToolkitFromError)
    : defaultToolkitAvailable;

  const record = { toolkit, availability };
  cachedToolkitAvailability.set(toolkit.name, record);
  return record;
}

export async function resolveAvailableToolkits(
  toolkits: AgentToolkit[],
  options: { force?: boolean } = {},
): Promise<AgentToolkit[]> {
  const records = await Promise.all(
    toolkits.map((toolkit) => resolveToolkitAvailability(toolkit, options)),
  );
  return records
    .filter((record) => record.availability.available)
    .map((record) => record.toolkit);
}

export async function refreshCapability(
  capabilities: AgentCapability[],
  name: string,
  availableToolkits?: readonly AgentToolkit[],
): Promise<CapabilityAvailabilityRecord | null> {
  const capability = capabilities.find((item) => item.name === name);
  if (!capability) return null;
  return resolveCapabilityAvailability(capability, {
    force: true,
    availableToolkits,
  });
}

export async function refreshToolkit(
  toolkits: AgentToolkit[],
  name: string,
): Promise<ToolkitAvailabilityRecord | null> {
  const toolkit = toolkits.find((item) => item.name === name);
  if (!toolkit) return null;
  return resolveToolkitAvailability(toolkit, { force: true });
}
