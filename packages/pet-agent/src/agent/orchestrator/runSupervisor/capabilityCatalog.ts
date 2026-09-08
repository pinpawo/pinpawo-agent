import { createHash } from 'node:crypto';
import type { AgentCapability } from '../../../types/capability';
import type { CompiledAgentRegistry } from '../registry';

export type CapabilityCatalogEntry = {
  readonly capabilityName: string;
  readonly description: string;
  readonly toolkits: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  readonly content: string;
};

export type CapabilityCatalog = {
  readonly registryDigest: string;
  readonly capabilityNames: readonly string[];
  readonly entries: readonly CapabilityCatalogEntry[];
};

export function renderCapabilityDocument(capability: AgentCapability): string {
  return [
    '---',
    `name: ${JSON.stringify(capability.name)}`,
    `description: ${JSON.stringify(capability.description)}`,
    `uses: [${capability.uses.map((name) => JSON.stringify(name)).join(', ')}]`,
    'version: 1',
    '---',
    '',
    capability.instructions.content.trim(),
    '',
  ].join('\n');
}

/** Snapshot only the compiled capabilities allowed by this invocation's Host. */
export function createCapabilityCatalog(params: {
  registry: CompiledAgentRegistry;
  allowedCapabilityNames?: readonly string[];
}): CapabilityCatalog {
  const allowed = params.allowedCapabilityNames;
  if (allowed && (new Set(allowed).size !== allowed.length
    || allowed.some((name) => typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(name)))) {
    throw new Error('allowedCapabilityNames must contain unique valid Capability names');
  }
  const entries = params.registry.capabilities
    .filter(({ capability }) => !allowed || allowed.includes(capability.name))
    .sort((a, b) => a.capability.name < b.capability.name ? -1 : a.capability.name > b.capability.name ? 1 : 0)
    .map(({ capability, toolkits }) => Object.freeze({
      capabilityName: capability.name,
      description: capability.description,
      toolkits: Object.freeze(toolkits.map(({ name, description }) => Object.freeze({ name, description }))),
      content: capability.document?.content ?? renderCapabilityDocument(capability),
    }));
  return Object.freeze({
    registryDigest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    capabilityNames: Object.freeze(entries.map(({ capabilityName }) => capabilityName)),
    entries: Object.freeze(entries),
  });
}
