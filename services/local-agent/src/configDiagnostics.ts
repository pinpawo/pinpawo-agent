import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { buildLocalAgentRuntimeConfig, type LocalAgentRuntimeConfig } from './runtimeConfig';
import type { StoredConfig } from './storage';
import { configPath } from './storage';

export type SetupCheckStatus = 'ok' | 'missing' | 'warning';

export type SetupCheck = {
  id: string;
  label: string;
  status: SetupCheckStatus;
  detail: string;
  nextStep?: string;
};

export type SetupGuide = {
  configPath: string;
  workdir: string;
  stateRoot: string;
  readyForLocalRun: boolean;
  checks: SetupCheck[];
  nextSteps: string[];
};

type EnvMap = Record<string, string | undefined>;

export function isMissingOrGeneratedApiPlaceholder(envKey: string, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (envKey === 'API_BASE_URL') return /your-api\.example\.com/i.test(trimmed);
  if (envKey === 'HASURA_ENDPOINT') return /your-hasura\.example\.com/i.test(trimmed);
  if (envKey === 'AGENT_TOKEN') return /^your-agent-token-here$/i.test(trimmed);
  if (envKey === 'HASURA_JWT') return trimmed === 'eyJ...' || /^your-hasura-jwt/i.test(trimmed);
  return false;
}

export function loadSetupEnvironment(baseEnv: EnvMap = process.env): EnvMap {
  const merged: EnvMap = { ...baseEnv };
  for (const envFile of [resolve(homedir(), '.pinpawo', '.env'), resolve(process.cwd(), '.env')]) {
    if (!existsSync(envFile)) continue;
    for (const [key, value] of Object.entries(parseDotEnv(readFileSync(envFile, 'utf-8')))) {
      if (!(key in merged)) merged[key] = value;
    }
  }
  return merged;
}

export function buildSetupGuide(options: {
  stored: StoredConfig;
  env?: EnvMap;
  configFilePath?: string;
  workdir?: string;
  runtimeConfig?: LocalAgentRuntimeConfig;
}): SetupGuide {
  const env = options.env ?? process.env;
  const runtimeConfig = options.runtimeConfig
    ?? buildLocalAgentRuntimeConfig(
      options.workdir
      ?? env.PINPAWO_WORKDIR
      ?? (typeof options.stored.workdir === 'string' ? options.stored.workdir : undefined)
      ?? homedir(),
    );
  const llmApiKey = readConfigValue(env, options.stored, 'LLM_API_KEY', 'llm_api_key');
  const apiValues = [
    ['API_BASE_URL', readConfigValue(env, options.stored, 'API_BASE_URL', 'api_base_url')],
    ['HASURA_ENDPOINT', readConfigValue(env, options.stored, 'HASURA_ENDPOINT', 'hasura_endpoint')],
    ['AGENT_TOKEN', readConfigValue(env, options.stored, 'AGENT_TOKEN', 'agent_token')],
    ['HASURA_JWT', readConfigValue(env, options.stored, 'HASURA_JWT', 'hasura_jwt')],
  ] as const;
  const missingApiKeys = apiValues
    .filter(([key, value]) => isMissingOrGeneratedApiPlaceholder(key, value))
    .map(([key]) => key);
  const localOnlyMode = readBooleanConfigValue(env, options.stored, 'PINPAWO_LOCAL_ONLY', 'local_only') ?? false;
  const hostedApiConfigured = missingApiKeys.length === 0;
  const hostedApiEnabled = hostedApiConfigured && !localOnlyMode;
  const actorId = options.stored.actor_id?.trim() ?? '';
  const readyForLocalRun = Boolean(llmApiKey.trim());
  const checks: SetupCheck[] = [
    readyForLocalRun
      ? {
          id: 'llm',
          label: 'LLM API',
          status: 'ok',
          detail: 'LLM_API_KEY is configured.',
        }
      : {
          id: 'llm',
          label: 'LLM API',
          status: 'missing',
          detail: 'LLM_API_KEY is missing. Local chat/TUI cannot run until it is configured.',
          nextStep: 'Run "pinpawo-agent login" or set LLM_API_KEY in ~/.pinpawo/.env.',
        },
    localOnlyMode
      ? {
          id: 'hosted-api',
          label: 'Hosted app/API',
          status: 'warning',
          detail: 'PINPAWO_LOCAL_ONLY is enabled. Hosted app relay, scheduled posts, and Hasura context are disabled even if API credentials are configured.',
          nextStep: 'Unset PINPAWO_LOCAL_ONLY or set local_only=false in config.json to re-enable hosted API connections.',
        }
      : hostedApiConfigured
      ? {
          id: 'hosted-api',
          label: 'Hosted app/API',
          status: 'ok',
          detail: 'API credentials are configured.',
        }
      : {
          id: 'hosted-api',
          label: 'Hosted app/API',
          status: 'warning',
          detail: `Missing or placeholder values: ${missingApiKeys.join(', ')}. Local-only mode can still run, but hosted app relay, heartbeat, scheduled posts, and Hasura context are disabled.`,
          nextStep: 'Run "pinpawo-agent login" to configure hosted API credentials.',
        },
    actorId
      ? {
          id: 'actor',
          label: 'Actor',
          status: 'ok',
          detail: options.stored.actor_name ? `Selected actor: ${options.stored.actor_name}.` : 'Actor id is configured.',
        }
      : {
          id: 'actor',
          label: 'Actor',
          status: hostedApiEnabled ? 'missing' : 'warning',
          detail: hostedApiEnabled
            ? 'No hosted actor is selected.'
            : 'No actor is selected. Local-only mode will use the built-in local actor.',
          nextStep: hostedApiEnabled
            ? 'Run "pinpawo-agent actor" to choose a pet actor.'
            : 'After hosted login, run "pinpawo-agent actor" to choose a pet actor.',
        },
    buildStudioConfigCheck(runtimeConfig),
  ];

  return {
    configPath: options.configFilePath ?? configPath(),
    workdir: runtimeConfig.workdir,
    stateRoot: runtimeConfig.stateRoot,
    readyForLocalRun,
    checks,
    nextSteps: buildNextSteps(checks),
  };
}

export function formatSetupGuide(guide: SetupGuide): string {
  const lines = [
    'PinPawo Local Agent — Setup Guide',
    '',
    `Config file: ${guide.configPath}`,
    `Workdir: ${guide.workdir}`,
    `Runtime state: ${guide.stateRoot}`,
    `Local run: ${guide.readyForLocalRun ? 'ready' : 'blocked'}`,
    '',
    'Checks:',
    ...guide.checks.flatMap((check) => [
      `  ${formatStatus(check.status)} ${check.label}: ${check.detail}`,
      ...(check.nextStep ? [`     next: ${check.nextStep}`] : []),
    ]),
  ];

  if (guide.nextSteps.length > 0) {
    lines.push('', 'Recommended next steps:');
    lines.push(...guide.nextSteps.map((step, index) => `  ${index + 1}. ${step}`));
  }

  return `${lines.join('\n')}\n`;
}

function buildStudioConfigCheck(runtimeConfig: LocalAgentRuntimeConfig): SetupCheck {
  if (existsSync(runtimeConfig.studioConfigPath)) {
    return {
      id: 'studio-config',
      label: 'Studio config',
      status: 'ok',
      detail: `Found ${runtimeConfig.studioConfigPath}.`,
    };
  }

  return {
    id: 'studio-config',
    label: 'Studio config',
    status: 'warning',
    detail: `No Studio config at ${runtimeConfig.studioConfigPath}. Studio mode will stay disabled until this file exists.`,
    nextStep: `Create ${runtimeConfig.studioConfigPath}.`,
  };
}

function buildNextSteps(checks: SetupCheck[]) {
  const steps: string[] = [];
  for (const check of checks) {
    if (check.nextStep && !steps.includes(check.nextStep)) {
      steps.push(check.nextStep);
    }
  }
  if (!steps.includes('Run "pinpawo-agent tui" to start the terminal UI.')) {
    steps.push('Run "pinpawo-agent tui" to start the terminal UI.');
  }
  return steps;
}

function readConfigValue(
  env: EnvMap,
  stored: StoredConfig,
  envKey: string,
  storedKey: keyof StoredConfig,
) {
  const storedValue = stored[storedKey];
  return env[envKey]?.trim() || (typeof storedValue === 'string' ? storedValue.trim() : '') || '';
}

function readBooleanConfigValue(
  env: EnvMap,
  stored: StoredConfig,
  envKey: string,
  storedKey: keyof StoredConfig,
): boolean | undefined {
  const envValue = env[envKey]?.trim();
  const storedValue = stored[storedKey];
  const raw = envValue
    || (typeof storedValue === 'boolean' ? String(storedValue) : '')
    || '';
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return undefined;
}

function formatStatus(status: SetupCheckStatus) {
  if (status === 'ok') return '[ok]';
  if (status === 'missing') return '[missing]';
  return '[warning]';
}

function parseDotEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    values[key] = value;
  }
  return values;
}
