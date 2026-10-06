import { hostConfiguration, HOST_CONFIGURATION_PATH, type HostConfigurationPort } from './persistence/configuration';
import type { StoredModelProfilesV1 } from './config/modelProfiles';

export type StoredConfig = {
  llm_api_key?: string;
  llm_model_preset?: string;
  llm_base_url?: string;
  llm_model?: string;
  llm_observe_model?: string;
  llm_context_window_tokens?: number;
  /** Versioned multi-profile model configuration. */
  models?: StoredModelProfilesV1;
  workdir?: string;
  /** Retry the same structured-output LLM call after parse/schema failure. Default: false. */
  structured_output_auto_repair?: boolean;
  /** Additional repair retries after the initial structured-output call. Default: 1 when enabled. */
  structured_output_repair_max_retries?: number;
  /** Built-in global review policy mode: require_authorization, auto_authorization, or full_access. */
  global_review_policy?: string;
  /** Automatic-review threshold: strict or relaxed. */
  auto_authorization_safety_level?: string;
  /**
   * Per-capability enabled/disabled overrides.
   * Keys match AgentCapability.name / CapabilityMeta.id.
   * Absent key = use the capability's defaultEnabled value (true for built-ins).
   */
  capabilities?: Record<string, boolean>;
  /**
   * Additional directories to scan for user-defined capability plugins,
   * appended to the default ~/.pinpawo/capabilities/ path.
   * Supports ~ expansion.  Also readable via PINPAWO_CAPABILITY_DIRS env var
   * (platform path-delimiter-separated).
   */
  capability_dirs?: string[];
};

/** Compatibility facade delegates to the selected port; the CLI default is explicit. */
export function loadStoredConfig(configuration: HostConfigurationPort = hostConfiguration): Promise<StoredConfig> {
  return configuration.readConfiguration();
}
export function saveStoredConfig(config: StoredConfig, configuration: HostConfigurationPort = hostConfiguration): Promise<void> {
  return configuration.replaceConfiguration(config);
}
export function configPath() { return HOST_CONFIGURATION_PATH; }
// CLI bootstrap snapshot for synchronous, pure builders. Not a durable read/write cache.
export const startupStoredConfig = await loadStoredConfig(hostConfiguration);
