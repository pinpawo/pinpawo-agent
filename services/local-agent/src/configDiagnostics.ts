import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { buildLocalAgentRuntimeConfig, type LocalAgentRuntimeConfig } from './runtimeConfig';
import {
  buildModelProfileRegistry,
  ModelProfileConfigError,
  resolveModelProfile,
} from './modelProfiles';
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
  let resolvedModelLabel = '';
  let modelConfigError = '';
  try {
    const registry = buildModelProfileRegistry({
      stored: options.stored,
      env,
    });
    const profile = resolveModelProfile(registry);
    resolvedModelLabel = `${profile.label} (${profile.id})`;
  } catch (error) {
    modelConfigError = error instanceof ModelProfileConfigError
      ? error.message
      : String(error);
  }
  const readyForLocalRun = Boolean(resolvedModelLabel);
  const checks: SetupCheck[] = [
    readyForLocalRun
      ? {
          id: 'llm',
          label: 'LLM API',
          status: 'ok',
          detail: `Default model profile is runnable: ${resolvedModelLabel}.`,
        }
      : {
          id: 'llm',
          label: 'LLM API',
          status: 'missing',
          detail: `No runnable default model profile. ${modelConfigError}`,
          nextStep: 'Configure LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL together in ~/.pinpawo/.env.',
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
    detail: `No Studio config at ${runtimeConfig.studioConfigPath}. An independent Studio Host cannot initialize this workdir until the file exists.`,
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
  if (!steps.includes('Run "pinpawo tui" to start the terminal UI.')) {
    steps.push('Run "pinpawo tui" to start the terminal UI.');
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
