import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
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
}): SetupGuide {
  const env = options.env ?? process.env;
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
    missingApiKeys.length === 0
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
          status: missingApiKeys.length === 0 ? 'missing' : 'warning',
          detail: missingApiKeys.length === 0
            ? 'No hosted actor is selected.'
            : 'No actor is selected. Local-only mode will use the built-in local actor.',
          nextStep: missingApiKeys.length === 0
            ? 'Run "pinpawo-agent actor" to choose a pet actor.'
            : 'After hosted login, run "pinpawo-agent actor" to choose a pet actor.',
        },
  ];

  return {
    configPath: options.configFilePath ?? configPath(),
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
