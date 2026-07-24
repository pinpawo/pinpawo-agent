import type {
  AgentToolkit,
  ToolkitAvailability,
} from '@pinpawo/pet-agent';

export type ToolkitAvailabilityRecord = {
  toolkit: AgentToolkit;
  availability: ToolkitAvailability;
};

const defaultToolkitAvailable: ToolkitAvailability = {
  available: true,
};

const cachedToolkitAvailability = new Map<string, ToolkitAvailability>();

function unavailableToolkitFromError(error: unknown): ToolkitAvailability {
  return {
    available: false,
    reason: error instanceof Error ? error.message : 'availability check failed',
  };
}

export function getCachedToolkitAvailability(name: string): ToolkitAvailability | null {
  return cachedToolkitAvailability.get(name) ?? null;
}

export async function resolveToolkitAvailability(
  toolkit: AgentToolkit,
  options: { force?: boolean } = {},
): Promise<ToolkitAvailabilityRecord> {
  if (!options.force) {
    const cached = cachedToolkitAvailability.get(toolkit.name);
    if (cached) return { toolkit, availability: cached };
  }

  const availability = toolkit.availability
    ? await Promise.resolve(toolkit.availability()).catch(unavailableToolkitFromError)
    : defaultToolkitAvailable;

  const record = { toolkit, availability };
  cachedToolkitAvailability.set(toolkit.name, availability);
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

export async function refreshToolkit(
  toolkits: AgentToolkit[],
  name: string,
): Promise<ToolkitAvailabilityRecord | null> {
  const toolkit = toolkits.find((item) => item.name === name);
  if (!toolkit) return null;
  return resolveToolkitAvailability(toolkit, { force: true });
}
