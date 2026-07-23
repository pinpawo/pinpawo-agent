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
  reason: 'no availability check',
};

const defaultToolkitAvailable: ToolkitAvailability = {
  available: true,
};

const cachedAvailability = new Map<string, CapabilityAvailabilityRecord>();
const cachedToolkitAvailability = new Map<string, ToolkitAvailabilityRecord>();

function unavailableFromError(error: unknown): CapabilityAvailability {
  return {
    available: false,
    reason: error instanceof Error ? error.message : 'availability check failed',
  };
}

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
  options: { force?: boolean } = {},
): Promise<CapabilityAvailabilityRecord> {
  const cacheMode = capability.availability?.cache ?? 'startup';
  if (!options.force && cacheMode !== 'none') {
    const cached = cachedAvailability.get(capability.name);
    if (cached) return cached;
  }

  const availability = capability.availability
    ? await Promise.resolve(capability.availability.check()).catch(unavailableFromError)
    : defaultAvailable;

  const record = { capability, availability };
  if (cacheMode !== 'none') {
    cachedAvailability.set(capability.name, record);
  }
  return record;
}

export async function resolveAvailableCapabilities(
  capabilities: AgentCapability[],
  options: { force?: boolean } = {},
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
): Promise<CapabilityAvailabilityRecord | null> {
  const capability = capabilities.find((item) => item.name === name);
  if (!capability) return null;
  return resolveCapabilityAvailability(capability, { force: true });
}

export async function refreshToolkit(
  toolkits: AgentToolkit[],
  name: string,
): Promise<ToolkitAvailabilityRecord | null> {
  const toolkit = toolkits.find((item) => item.name === name);
  if (!toolkit) return null;
  return resolveToolkitAvailability(toolkit, { force: true });
}
