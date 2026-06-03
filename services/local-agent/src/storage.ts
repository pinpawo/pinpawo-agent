import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_PATH = resolve(homedir(), '.pinpawo', 'config.json');

export type StoredConfig = {
  api_base_url?: string;
  hasura_endpoint?: string;
  agent_token?: string;
  hasura_jwt?: string;
  user_id?: string;
  nickname?: string;
  actor_id?: string;
  actor_name?: string;
  llm_api_key?: string;
  llm_base_url?: string;
  llm_model?: string;
  llm_observe_model?: string;
  llm_context_window_tokens?: number;
  mediacrawler_dir?: string;
  xhs_cookie?: string;
  workdir?: string;
  browser_backend?: string;
  /**
   * Per-capability enabled/disabled overrides.
   * Keys match AgentCapability.name / CapabilityMeta.id.
   * Absent key = use the capability's defaultEnabled value (true for built-ins).
   */
  /** Enable thinking/reasoning for subagent calls. Default: false. */
  subagent_thinking?: boolean;
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
