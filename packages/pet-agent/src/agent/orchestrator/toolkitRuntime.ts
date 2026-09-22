import { isJsonValue, type JsonValue } from '@pinpawo/agent-contracts';
import type { AgentToolkit, ToolkitRuntimeIdentity } from '../../types/toolkit';

/** Host-owned client and its fixed service connection / environment identity. */
export type ToolkitRuntimeClientBinding = Readonly<{
  runtimeType: string;
  client: unknown;
  identity: ToolkitRuntimeIdentity;
  diagnose?: () => JsonValue | Promise<JsonValue>;
}>;

export type ToolkitRuntimeSelection = Readonly<{
  runtimes: Readonly<Record<string, unknown>>;
  identities: Readonly<Record<string, ToolkitRuntimeIdentity>>;
}>;

export type ToolkitRuntimeDiagnostic = Readonly<{
  toolkitName: string;
  runtimeType: string;
  identity: ToolkitRuntimeIdentity;
  details?: JsonValue;
  error?: string;
}>;

/** Static client injection only. The Host owns the connection, the service owns resources. */
export class ToolkitRuntimeManager {
  private bindings: Readonly<Record<string, ToolkitRuntimeClientBinding>> = Object.freeze({});

  constructor(bindings: Readonly<Record<string, ToolkitRuntimeClientBinding>> = {}) {
    this.replaceBindings(bindings);
  }

  replaceBindings(bindings: Readonly<Record<string, ToolkitRuntimeClientBinding>>): void {
    const entries = Object.entries(bindings).map(([name, binding]) => {
      if (!name.trim() || !binding.runtimeType?.trim()
        || !binding.identity?.clientId?.trim() || !binding.identity?.instanceId?.trim()
        || binding.client == null) {
        throw new Error(`Invalid Runtime client binding for Toolkit "${name}".`);
      }
      return [name, Object.freeze({ ...binding, identity: Object.freeze({
        clientId: binding.identity.clientId, instanceId: binding.identity.instanceId,
      }) })] as const;
    });
    this.bindings = Object.freeze(Object.fromEntries(entries));
  }

  select(toolkits: readonly AgentToolkit[]): ToolkitRuntimeSelection {
    const runtimes: Record<string, unknown> = {};
    const identities: Record<string, ToolkitRuntimeIdentity> = {};
    for (const toolkit of toolkits) {
      if (!toolkit.runtime) continue;
      const binding = Object.hasOwn(this.bindings, toolkit.name) ? this.bindings[toolkit.name] : undefined;
      if (!binding) throw new Error(`Toolkit "${toolkit.name}" requires Runtime "${toolkit.runtime}" but no client is configured.`);
      if (binding.runtimeType !== toolkit.runtime) {
        throw new Error(`Toolkit "${toolkit.name}" requires Runtime "${toolkit.runtime}", received "${binding.runtimeType}".`);
      }
      Object.defineProperty(runtimes, toolkit.name, { value: binding.client, enumerable: true });
      Object.defineProperty(identities, toolkit.name, { value: binding.identity, enumerable: true });
    }
    return Object.freeze({ runtimes: Object.freeze(runtimes), identities: Object.freeze(identities) });
  }

  async diagnose(): Promise<readonly ToolkitRuntimeDiagnostic[]> {
    return Promise.all(Object.entries(this.bindings).map(async ([toolkitName, binding]) => {
      const base = { toolkitName, runtimeType: binding.runtimeType, identity: binding.identity };
      try {
        const details = await binding.diagnose?.();
        if (details !== undefined && !isJsonValue(details)) throw new Error('Runtime diagnostics must be JSON values.');
        return Object.freeze({ ...base, ...(details !== undefined ? { details } : {}) });
      } catch (error) {
        return Object.freeze({ ...base, error: error instanceof Error ? error.message : String(error) });
      }
    }));
  }
}
