import type { CapabilityMeta } from './capabilityRegistry';
import { loadStoredConfig, type StoredConfig } from './storage';

/**
 * Resolve a Capability's effective enablement from one configuration snapshot.
 *
 * An absent override deliberately preserves the authored default.  This is
 * shared by request assembly and the HTTP projection so the UI cannot report a
 * different state from the one Chat executes.
 */
export function resolveCapabilityEnabled(
  meta: Pick<CapabilityMeta, 'id' | 'defaultEnabled'>,
  config: Pick<StoredConfig, 'capabilities'> = loadStoredConfig(),
): boolean {
  const override = config.capabilities?.[meta.id];
  return override ?? meta.defaultEnabled;
}
