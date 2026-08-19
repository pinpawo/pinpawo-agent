import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  buildModelProfileRegistry,
  fingerprintModelProfile,
  resolveModelProfile,
  type ModelProfileRegistrySnapshot,
} from './modelProfiles';
import { loadStoredConfig } from './storage';
import {
  GLOBAL_REVIEW_POLICY_MODE,
  type BuiltinGlobalReviewPolicyMode,
  type CapabilityRegistryBackend,
} from '@pinpawo/pet-agent';
import {
  DEFAULT_TOOL_AUTHORIZATION_SAFETY_LEVEL,
  isToolAuthorizationSafetyLevel,
  type ToolAuthorizationSafetyLevel,
} from '@pinpawo/agent-contracts';

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

export function resolveNumberConfigValue(envVal: string | undefined, storedVal: unknown): number | undefined {
  const raw = envVal?.trim() ? envVal : (typeof storedVal === 'number' ? String(storedVal) : '');
  if (!raw.trim()) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed)
    ? parsed
    : undefined;
}

function resolveBooleanConfigValue(envVal: string | undefined, storedVal: unknown): boolean | undefined {
  const raw = envVal?.trim()
    ? envVal.trim().toLowerCase()
    : (typeof storedVal === 'boolean' ? String(storedVal) : '');
  if (!raw) return undefined;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return undefined;
}

function getNumber(envKey: string, storedKey: keyof typeof stored): number | undefined {
  return resolveNumberConfigValue(process.env[envKey], stored[storedKey]);
}

function getBoolean(envKey: string, storedKey: keyof typeof stored): boolean | undefined {
  return resolveBooleanConfigValue(process.env[envKey], stored[storedKey]);
}

function resolveGlobalReviewPolicyMode(raw: string | undefined): BuiltinGlobalReviewPolicyMode | undefined {
  const normalized = raw?.trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return undefined;
  if ([
    'require-authorization',
    'require-approval',
    'authorization-required',
    'ask',
    'manual',
    'always-ask',
    'require',
    'require-review',
  ].includes(normalized)) {
    return GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION;
  }
  if ([
    'auto-authorization',
    'auto-authorize',
    'automatic-authorization',
    'auto',
    'automatic',
    'auto-approve',
    'auto-review',
  ].includes(normalized)) {
    return GLOBAL_REVIEW_POLICY_MODE.AUTO_AUTHORIZATION;
  }
  if ([
    'full-access',
    'always-allow',
    'allow-all',
    'unrestricted',
    'trusted',
  ].includes(normalized)) {
    return GLOBAL_REVIEW_POLICY_MODE.FULL_ACCESS;
  }
  return undefined;
}

function getGlobalReviewPolicyMode(): BuiltinGlobalReviewPolicyMode {
  return resolveGlobalReviewPolicyMode(process.env.PINPAWO_GLOBAL_REVIEW_POLICY)
    ?? resolveGlobalReviewPolicyMode(typeof stored.global_review_policy === 'string'
      ? stored.global_review_policy
      : undefined)
    ?? GLOBAL_REVIEW_POLICY_MODE.REQUIRE_AUTHORIZATION;
}

export function resolveAutoAuthorizationSafetyLevel(
  value: unknown,
): ToolAuthorizationSafetyLevel {
  return isToolAuthorizationSafetyLevel(value)
    ? value
    : DEFAULT_TOOL_AUTHORIZATION_SAFETY_LEVEL;
}

function getAutoAuthorizationSafetyLevel(): ToolAuthorizationSafetyLevel {
  return resolveAutoAuthorizationSafetyLevel(stored.auto_authorization_safety_level);
}

export function resolveCapabilityRegistryBackend(
  raw: string | undefined,
): CapabilityRegistryBackend | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'filesystem') {
    return 'filesystem';
  }
  if (normalized === 'memory') {
    return 'memory';
  }
  throw new Error(
    'Capability registry backend must be "filesystem" or "memory".',
  );
}

const modelProfileRegistry = buildModelProfileRegistry({
  stored,
  env: process.env,
});
const selectedModelProfile = resolveModelProfile(modelProfileRegistry);
const selectedModelProfileFingerprint = fingerprintModelProfile(selectedModelProfile).fingerprint;

export type Config = Readonly<{
  modelProfileRegistry: ModelProfileRegistrySnapshot;
  modelProfileId: string;
  modelProfileFingerprint: string;
  structuredOutputAutoRepair?: boolean;
  structuredOutputRepairMaxRetries?: number;
  globalReviewPolicyMode: BuiltinGlobalReviewPolicyMode;
  autoAuthorizationSafetyLevel: ToolAuthorizationSafetyLevel;
  workdir: string;
  browserBackend: string;
  capabilityRegistryBackend: CapabilityRegistryBackend;
  localServerPort: number;
}>;

export type ConfigInput = Partial<Config>;

function freezeConfig(input: Config): Config {
  return Object.freeze({ ...input });
}

function readConfigDefaults(): Config {
  return freezeConfig({
    modelProfileRegistry,
    modelProfileId: selectedModelProfile.id,
    modelProfileFingerprint: selectedModelProfileFingerprint,
    structuredOutputAutoRepair: getBoolean(
      'LLM_STRUCTURED_OUTPUT_AUTO_REPAIR',
      'structured_output_auto_repair',
    ),
    structuredOutputRepairMaxRetries: getNumber(
      'LLM_STRUCTURED_OUTPUT_REPAIR_MAX_RETRIES',
      'structured_output_repair_max_retries',
    ),
    globalReviewPolicyMode: getGlobalReviewPolicyMode(),
    autoAuthorizationSafetyLevel: getAutoAuthorizationSafetyLevel(),
    workdir: get('PINPAWO_WORKDIR', 'workdir') || process.cwd() || homedir(),
    browserBackend: get('PINPAWO_BROWSER_BACKEND', 'browser_backend') || 'auto',
    capabilityRegistryBackend: resolveCapabilityRegistryBackend(
      get(
        'PINPAWO_CAPABILITY_REGISTRY_BACKEND',
        'capability_registry_backend',
      ),
    ) ?? 'filesystem',
    localServerPort: Number(process.env.LOCAL_SERVER_PORT ?? 3210),
  });
}

const defaultConfig = readConfigDefaults();
let currentConfig = defaultConfig;

export function getConfig(): Config {
  return currentConfig;
}

export function buildConfig(input: ConfigInput = {}, defaults: Config = defaultConfig): Config {
  return freezeConfig({
    ...defaults,
    ...input,
  });
}

export function setConfig(input: ConfigInput | ((current: Config) => ConfigInput)): Config {
  const patch = typeof input === 'function' ? input(currentConfig) : input;
  currentConfig = buildConfig(patch, currentConfig);
  return currentConfig;
}
