import type { BuiltinGlobalReviewPolicyMode, CapabilityRegistryBackend } from '@pinpawo/pet-agent';
import type { ToolAuthorizationSafetyLevel } from '@pinpawo/agent-contracts';
import { getConfig } from './config';
import type { LocalAgentRuntimeConfig } from './runtimeConfig';

/** Resolved Host settings. Consumers never consult process defaults. */
export type HostExecutionConfig = Readonly<{
  runtimeConfig: LocalAgentRuntimeConfig;
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
  autoAuthorizationSafetyLevel: ToolAuthorizationSafetyLevel;
  capabilityRegistryBackend: CapabilityRegistryBackend;
}>;

/** Resolve process defaults once at the composing Host's construction boundary. */
export function resolveHostExecutionConfig(
  runtimeConfig: LocalAgentRuntimeConfig,
  settings: Omit<HostExecutionConfig, 'runtimeConfig'> = getConfig(),
): HostExecutionConfig {
  return Object.freeze({
    runtimeConfig,
    globalReviewPolicyMode: settings.globalReviewPolicyMode,
    autoAuthorizationSafetyLevel: settings.autoAuthorizationSafetyLevel,
    capabilityRegistryBackend: settings.capabilityRegistryBackend,
  });
}
