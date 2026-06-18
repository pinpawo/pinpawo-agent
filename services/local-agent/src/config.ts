import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { isMissingOrGeneratedApiPlaceholder } from './configDiagnostics';
import { inferLlmContextWindowTokens } from './llmContextWindow';
import { loadStoredConfig } from './storage';

export { isMissingOrGeneratedApiPlaceholder } from './configDiagnostics';

function parseDotEnv(content: string) {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

function loadDotEnv() {
  // 1. ~/.pinpawo/.env — always accessible (dev + app bundle)
  try { parseDotEnv(readFileSync(resolve(homedir(), '.pinpawo', '.env'), 'utf-8')); } catch { /* ok */ }
  // 2. cwd/.env — dev mode convenience (wins only for keys not already set)
  try { parseDotEnv(readFileSync(resolve(process.cwd(), '.env'), 'utf-8')); } catch { /* ok */ }
}

loadDotEnv();

const stored = loadStoredConfig();

function get(envKey: string, storedKey: keyof typeof stored): string {
  const storedVal = stored[storedKey];
  return process.env[envKey] || (typeof storedVal === 'string' ? storedVal : '') || '';
}

function optional(envKey: string, storedKey: keyof typeof stored): string {
  return get(envKey, storedKey).trim();
}

export function resolveNumberConfigValue(envVal: string | undefined, storedVal: unknown): number | undefined {
  const raw = envVal?.trim() ? envVal : (typeof storedVal === 'number' ? String(storedVal) : '');
  if (!raw.trim()) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed)
    ? parsed
    : undefined;
}

function getNumber(envKey: string, storedKey: keyof typeof stored): number | undefined {
  return resolveNumberConfigValue(process.env[envKey], stored[storedKey]);
}

function required(envKey: string, storedKey: keyof typeof stored, label: string): string {
  const val = get(envKey, storedKey);
  if (!val) {
    throw new Error(
      `Missing: ${label}\nRun "pinpawo-agent login" or set ${envKey} in .env`
    );
  }
  return val;
}

const apiBaseUrl = optional('API_BASE_URL', 'api_base_url').replace(/\/$/, '');
const hasuraEndpoint = optional('HASURA_ENDPOINT', 'hasura_endpoint').replace(/\/$/, '');
const agentToken = optional('AGENT_TOKEN', 'agent_token');
const hasuraJwt = optional('HASURA_JWT', 'hasura_jwt');
const apiCredentialValues = [
  ['API_BASE_URL', apiBaseUrl],
  ['HASURA_ENDPOINT', hasuraEndpoint],
  ['AGENT_TOKEN', agentToken],
  ['HASURA_JWT', hasuraJwt],
] as const;
const missingOrPlaceholderApiConfig = apiCredentialValues
  .filter(([key, value]) => isMissingOrGeneratedApiPlaceholder(key, value))
  .map(([key]) => key);

export const config = {
  apiBaseUrl,
  hasuraEndpoint,
  agentToken,
  hasuraJwt,
  apiConnected: missingOrPlaceholderApiConfig.length === 0,
  apiSetupMessage: missingOrPlaceholderApiConfig.length > 0
    ? `API login is not configured (${missingOrPlaceholderApiConfig.join(', ')}). Local-only mode is enabled; run "pinpawo-agent login" to enable the hosted app, chat relay, and Hasura-backed context.`
    : '',

  llmApiKey: required('LLM_API_KEY', 'llm_api_key', 'LLM_API_KEY'),
  llmBaseUrl: get('LLM_BASE_URL', 'llm_base_url') || 'https://api.deepseek.com',
  llmModel: get('LLM_MODEL', 'llm_model') || 'deepseek-v4-pro',
  llmContextWindowTokens:
    getNumber('LLM_CONTEXT_WINDOW_TOKENS', 'llm_context_window_tokens')
    ?? inferLlmContextWindowTokens(get('LLM_MODEL', 'llm_model') || 'deepseek-v4-pro')
    ?? 32000,

  workdir: get('PINPAWO_WORKDIR', 'workdir') || homedir(),
  browserBackend: get('PINPAWO_BROWSER_BACKEND', 'browser_backend') || 'auto',

  /** Extra capability plugin directories beyond ~/.pinpawo/capabilities/ */
  get capabilityDirs(): string[] {
    const fromEnv = process.env.PINPAWO_CAPABILITY_DIRS?.split(':').filter(Boolean) ?? [];
    const fromStored = (stored.capability_dirs ?? []);
    return [...new Set([...fromEnv, ...fromStored])];
  },

  pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS ?? 60),

  localServerPort: Number(process.env.LOCAL_SERVER_PORT ?? 3210),
};
