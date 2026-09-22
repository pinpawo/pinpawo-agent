import type { JsonValue } from '@pinpawo/agent-contracts';
import type { DelegationScope } from '@pinpawo/pet-agent';

export type RuntimeExecution = DelegationScope & { workdir: string | null };

export type RuntimeCallContext = Readonly<{
  clientId: string;
  toolkitName: string;
  execution: RuntimeExecution;
  signal: AbortSignal;
}>;

export type RuntimeInstanceConfig = Readonly<{
  kind: string;
  [key: string]: unknown;
}>;

/** An execution environment owned exclusively by the runtime service. */
export interface RuntimeInstance {
  call(method: string, args: unknown, context: RuntimeCallContext): Promise<unknown>;
  releaseClient(clientId: string): Promise<void>;
  close(): Promise<void>;
  diagnose(): JsonValue | Promise<JsonValue>;
}

export type RuntimeFactory = (
  config: RuntimeInstanceConfig,
) => RuntimeInstance | Promise<RuntimeInstance>;

export type RuntimeServiceConfig = Readonly<{
  instances: Readonly<Record<string, RuntimeInstanceConfig>>;
  toolkitBindings: Readonly<Record<string, string>>;
  /** Trusted, operator-configured service modules. Never accepted over IPC. */
  modules?: readonly string[];
}>;

/** Shared by typed Toolkit clients; instance selection remains fixed at connect. */
export interface RuntimeCaller {
  call(
    toolkitName: string,
    method: string,
    args: unknown,
    execution: RuntimeExecution,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
