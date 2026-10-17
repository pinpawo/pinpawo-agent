import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFile } from './atomicFile';
import type { StoredModelProfilesV1 } from './config/modelProfiles';

const CONFIG_PATH = resolve(homedir(), '.pinpawo', 'config.json');

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

/**
 * A missing config reads as empty. One that cannot be read or is not a JSON
 * object also reads as empty, so commands still run, but it is never saved
 * over: the user's model, workdir and capability settings stay on disk.
 */
export function loadStoredConfig(): StoredConfig {
  const read = readStoredConfigFile();
  if ('config' in read) return read.config;
  if (!warnedUnreadableConfig) {
    warnedUnreadableConfig = true;
    console.warn(`[pinpawo] ignoring ${CONFIG_PATH}: ${read.reason}`);
  }
  return {};
}

export function saveStoredConfig(config: StoredConfig) {
  const read = readStoredConfigFile();
  if ('reason' in read) {
    throw new Error(`Refusing to overwrite ${CONFIG_PATH}: ${read.reason}. Fix or remove the file, then retry.`);
  }
  atomicWriteFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let warnedUnreadableConfig = false;

function readStoredConfigFile(): { config: StoredConfig } | { reason: string } {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { config: {} };
    return { reason: `cannot be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: 'is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { reason: 'is not a JSON object' };
  }
  return { config: parsed as StoredConfig };
}

export function configPath() {
  return CONFIG_PATH;
}
