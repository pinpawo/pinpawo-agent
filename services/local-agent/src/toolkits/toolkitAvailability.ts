import type {
  AgentToolkit,
  ToolkitAvailability,
} from '@pinpawo/pet-agent';
import { evaluateToolkitAvailability } from '@pinpawo/pet-agent';

export type ToolkitAvailabilityRecord = {
  toolkit: AgentToolkit;
  availability: ToolkitAvailability;
};

const cachedToolkitAvailability = new WeakMap<AgentToolkit, ToolkitAvailability>();

export async function resolveToolkitAvailability(
  toolkit: AgentToolkit,
  options: { force?: boolean } = {},
): Promise<ToolkitAvailabilityRecord> {
  if (!options.force) {
    const cached = cachedToolkitAvailability.get(toolkit);
    if (cached) return { toolkit, availability: cached };
  }

  const availability = await evaluateToolkitAvailability(toolkit);

  const record = { toolkit, availability };
  cachedToolkitAvailability.set(toolkit, availability);
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
