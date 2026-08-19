import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { StoredModelProfilesV1 } from './modelProfiles';

const CONFIG_PATH = resolve(homedir(), '.pinpawo', 'config.json');

export type StoredConfig = {
  user_id?: string;
  nickname?: string;
  actor_id?: string;
  actor_name?: string;
  llm_api_key?: string;
  llm_model_preset?: string;
  llm_base_url?: string;
  llm_model?: string;
  llm_observe_model?: string;
  llm_context_window_tokens?: number;
  /** Versioned multi-profile model configuration. */
  models?: StoredModelProfilesV1;
  workdir?: string;
  browser_backend?: string;
  /** Capability document registry search backend: filesystem or memory. */
  capability_registry_backend?: string;
  /**
   * Per-capability enabled/disabled overrides.
   * Keys match AgentCapability.name / CapabilityMeta.id.
   * Absent key = use the capability's defaultEnabled value (true for built-ins).
   */
  /** Enable thinking/reasoning for subagent calls. Default: false. */
  subagent_thinking?: boolean;
  /** Retry the same structured-output LLM call after parse/schema failure. Default: false. */
  structured_output_auto_repair?: boolean;
  /** Additional repair retries after the initial structured-output call. Default: 1 when enabled. */
  structured_output_repair_max_retries?: number;
  /** Built-in global review policy mode: require_authorization, auto_authorization, or full_access. */
  global_review_policy?: string;
  /** Automatic-review threshold: strict or relaxed. */
  auto_authorization_safety_level?: string;
  capabilities?: Record<string, boolean>;
  /**
   * Additional directories to scan for user-defined capability plugins,
   * appended to the default ~/.pinpawo/capabilities/ path.
   * Supports ~ expansion.  Also readable via PINPAWO_CAPABILITY_DIRS env var
   * (colon-separated).
   */
  capability_dirs?: string[];
};

export function loadStoredConfig(): StoredConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as StoredConfig;
  } catch {
    return {};
  }
}

export function saveStoredConfig(config: StoredConfig) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

export function configPath() {
  return CONFIG_PATH;
}
