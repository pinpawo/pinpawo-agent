import type { ToolAuthorizationSafetyLevel, ToolAuthorizationMode } from '@pinpawo/agent-contracts';
import { getConfig } from './config';
import type { HostRuntimeConfig } from './runtimeConfig';

/** Resolved Host settings. Consumers never consult process defaults. */
export type HostExecutionConfig = Readonly<{
  runtimeConfig: HostRuntimeConfig;
  toolAuthorizationMode: ToolAuthorizationMode;
  autoAuthorizationSafetyLevel: ToolAuthorizationSafetyLevel;
}>;

/** Resolve process defaults once at the composing Host's construction boundary. */
export function resolveHostExecutionConfig(
  runtimeConfig: HostRuntimeConfig,
  settings: Omit<HostExecutionConfig, 'runtimeConfig'> = getConfig(),
): HostExecutionConfig {
  return Object.freeze({
    runtimeConfig,
    toolAuthorizationMode: settings.toolAuthorizationMode,
    autoAuthorizationSafetyLevel: settings.autoAuthorizationSafetyLevel,
  });
}
